import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  RetryQueueService,
  JobHandler,
} from '../../common/retry/retry-queue.service';
import {
  approveMilestone,
  changeMilestoneStatus,
  TrustlessRelayError,
} from '../../internal-trustless/escrow-write.helper';
import type { ServiceType } from '../../internal-trustless/dto/escrow-write.dto';

// ── Constants ──────────────────────────────────────────────────────────────

/** Job type string used when enqueuing milestone syncs into the shared RetryQueueService. */
export const MILESTONE_SYNC_JOB_TYPE = 'milestone_sync';

// ── Types ──────────────────────────────────────────────────────────────────

export interface MilestoneSyncPayload {
  contractId: string;
  /** Thalos `agreement_type` value: 'single' | 'multi'. */
  agreementType: string;
  /** String index matching Trustless Work's milestoneIndex param. */
  milestoneIndex: string;
  action: 'approve' | 'change_status';
  /** Required when action === 'approve'. */
  approver?: string;
  /** Required when action === 'change_status'. */
  serviceProvider?: string;
  newEvidence?: string;
  newStatus?: string;
}

// ── Service ────────────────────────────────────────────────────────────────

/**
 * Thin milestone sync helpers consumed by the Agreement Synchronization Engine.
 *
 * Responsibilities:
 *  - Map Thalos `agreement_type` → TW `serviceType` path segment.
 *  - Push milestone actions to Trustless Work via shared escrow-write helpers.
 *  - Evaluate whether a TW→Thalos update should be applied (idempotency / conflict).
 *  - Enqueue failed pushes into the shared RetryQueueService.
 *
 * What this service does NOT do:
 *  - It does not own TW↔Thalos consistency — AgreementSyncService is authoritative.
 *  - It does not write to the DB — callers must invoke AgreementsService.updateMilestone().
 *  - It does not submit transactions — the FE/wallet must sign and submit the unsigned XDR.
 */
@Injectable()
export class MilestoneSyncService implements OnModuleInit {
  private readonly logger = new Logger(MilestoneSyncService.name);

  constructor(private readonly retryQueue: RetryQueueService) {}

  onModuleInit(): void {
    const handler: JobHandler = async (job) => {
      const payload = job.payload as unknown as MilestoneSyncPayload;
      return this.handleMilestoneUpdateJob(payload);
    };
    this.retryQueue.registerHandler(MILESTONE_SYNC_JOB_TYPE, handler);
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Maps Thalos `agreement_type` ('single' | 'multi') to the Trustless Work
   * serviceType path segment ('single-release' | 'multi-release').
   *
   * Sending the raw agreement_type string directly to TW endpoints causes a 404.
   */
  toTWServiceType(agreementType: string): ServiceType {
    return agreementType === 'multi' ? 'multi-release' : 'single-release';
  }

  /**
   * Pushes a milestone action to Trustless Work.
   *
   * ⚠️  TW write helpers return unsigned XDR — the transaction is NOT finalized on-chain.
   * The FE/wallet must call POST /escrows/send-transaction with the signed envelope.
   * Local milestone status must stay 'awaiting_signature' until the
   * escrow.milestone_updated webhook fires and confirms the on-chain state.
   */
  async pushMilestoneToTW(
    payload: MilestoneSyncPayload,
  ): Promise<{ unsignedTransaction: string }> {
    const type = this.toTWServiceType(payload.agreementType);

    let result: unknown;

    if (payload.action === 'approve') {
      result = await approveMilestone({
        contractId: payload.contractId,
        milestoneIndex: payload.milestoneIndex,
        approver: payload.approver ?? '',
        type,
      });
    } else {
      result = await changeMilestoneStatus({
        contractId: payload.contractId,
        milestoneIndex: payload.milestoneIndex,
        newStatus: payload.newStatus ?? '',
        newEvidence: payload.newEvidence ?? '',
        serviceProvider: payload.serviceProvider ?? '',
        type,
      });
    }

    // The response is always { unsignedTransaction: '<XDR string>' }.
    // Never treat this return value as a confirmed on-chain state change.
    return result as { unsignedTransaction: string };
  }

  /**
   * Returns true when TW reports a terminal milestone status ('approved' | 'released')
   * that the local DB has not yet reached — e.g. TW says 'approved' but local is 'pending'.
   * The caller should treat this as a conflict and log / alert rather than silently overwriting.
   */
  detectConflict(localStatus: string, twStatus: string): boolean {
    const terminal = new Set<string>(['approved', 'released']);
    return terminal.has(twStatus) && !terminal.has(localStatus);
  }

  /**
   * Evaluates whether a TW→Thalos milestone update should be applied.
   * Returns a discriminated result so the caller (sync engine / webhook handler) decides:
   *  - 'skipped'  — local already matches TW; no write needed (idempotent).
   *  - 'conflict' — TW is at a terminal status the local DB hasn't reached; needs review.
   *  - 'applied'  — safe to update local DB; caller must call AgreementsService.updateMilestone().
   */
  applyTWMilestoneUpdate(params: {
    currentLocalStatus: string;
    twStatus: string;
  }): 'applied' | 'skipped' | 'conflict' {
    if (params.currentLocalStatus === params.twStatus) return 'skipped';
    if (this.detectConflict(params.currentLocalStatus, params.twStatus)) return 'conflict';
    return 'applied';
  }

  /**
   * Enqueues a milestone push into the shared retry queue.
   * Returns the generated job id.
   */
  enqueueRetry(payload: MilestoneSyncPayload, options?: { maxRetries?: number }): string {
    return this.retryQueue.enqueue(MILESTONE_SYNC_JOB_TYPE, payload, options);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async handleMilestoneUpdateJob(
    payload: MilestoneSyncPayload,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.pushMilestoneToTW(payload);
      return { success: true };
    } catch (err) {
      // 4xx from TW = validation / bad-request — not worth backing off and retrying.
      if (err instanceof TrustlessRelayError && err.upstreamStatus < 500) {
        this.logger.warn(
          `Milestone update skipped for contract ${payload.contractId}: ` +
            `TW returned ${err.upstreamStatus} (non-retryable 4xx)`,
        );
        return { success: true }; // mark completed so the queue stops retrying
      }
      // 5xx / network errors → propagate failure so the queue applies backoff and retries.
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }
}
