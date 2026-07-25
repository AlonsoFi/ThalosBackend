import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RetryQueueService } from '../retry-queue/retry-queue.service';
import { RetryJobType } from '../retry-queue/retry-queue.types';
import {
  approveMilestone,
  changeMilestoneStatus,
  TrustlessRelayError,
} from '../internal-trustless/escrow-write.helper';
import type { ServiceType } from '../internal-trustless/dto/escrow-write.dto';

export interface MilestoneSyncPayload extends Record<string, unknown> {
  contractId: string;
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

/**
 * Thin milestone sync helpers consumed by the Agreement Synchronization Engine (#60).
 *
 * Responsibilities:
 *  - Map Thalos `agreement_type` → TW `serviceType` path segment.
 *  - Push milestone actions to Trustless Work via the shared escrow-write helpers.
 *  - Evaluate whether a TW→Thalos update should be applied (idempotency / conflict).
 *  - Enqueue failed pushes into the shared RetryQueueService (MILESTONE_UPDATE type).
 *
 * What this service does NOT do:
 *  - It does not own TW↔Thalos consistency — that is #60's responsibility.
 *  - It does not write to the DB — callers must invoke AgreementsService.updateMilestone().
 *  - It does not call send-transaction — the FE/wallet must sign and submit the XDR.
 */
@Injectable()
export class MilestoneSyncService implements OnModuleInit {
  private readonly logger = new Logger(MilestoneSyncService.name);

  constructor(private readonly retryQueue: RetryQueueService) {}

  onModuleInit(): void {
    this.retryQueue.registerHandler<MilestoneSyncPayload>(
      RetryJobType.MILESTONE_UPDATE,
      (payload) => this.handleMilestoneUpdateJob(payload),
    );
  }

  /**
   * Maps Thalos `agreement_type` ('single' | 'multi') to the Trustless Work
   * serviceType path segment ('single-release' | 'multi-release').
   *
   * Passing raw agreement_type directly to TW paths causes a 404.
   */
  toTWServiceType(agreementType: string): ServiceType {
    return agreementType === 'single' ? 'single-release' : 'multi-release';
  }

  /**
   * Pushes a milestone action to Trustless Work.
   *
   * ⚠️  Returns { unsignedTransaction } — the transaction is NOT finalized on-chain.
   * The FE/wallet must call POST /escrows/send-transaction to submit the signed XDR.
   * Local milestone status must remain 'awaiting_signature' until the corresponding
   * webhook (escrow.milestone_updated) fires and confirms the on-chain state.
   */
  async pushMilestoneToTW(payload: MilestoneSyncPayload): Promise<{ unsignedTransaction: string }> {
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

    return result as { unsignedTransaction: string };
  }

  /**
   * Returns true when TW reports a terminal milestone status ('approved' | 'released')
   * that the local DB has not yet reached — e.g. TW says 'approved' but local is 'pending'.
   * The caller should treat this as a conflict and log / alert rather than silently overwrite.
   */
  detectConflict(localStatus: string, twStatus: string): boolean {
    const terminal = new Set(['approved', 'released']);
    return terminal.has(twStatus) && !terminal.has(localStatus);
  }

  /**
   * Evaluates whether a TW→Thalos milestone update should be applied.
   * Returns a discriminated result so the caller (sync engine or webhook handler) decides:
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
   * Idempotency key prevents duplicate enqueues for the same operation.
   */
  async enqueueRetry(payload: MilestoneSyncPayload, idempotencyKey: string): Promise<void> {
    await this.retryQueue.enqueue(RetryJobType.MILESTONE_UPDATE, payload, idempotencyKey);
  }

  private async handleMilestoneUpdateJob(payload: MilestoneSyncPayload): Promise<void> {
    try {
      await this.pushMilestoneToTW(payload);
    } catch (err) {
      // 4xx from TW = validation / bad-request — not worth backing off and retrying.
      if (err instanceof TrustlessRelayError && err.upstreamStatus < 500) {
        this.logger.warn(
          `Milestone update skipped for contract ${payload.contractId}: ` +
            `TW returned ${err.upstreamStatus} (non-retryable 4xx)`,
        );
        return;
      }
      // 5xx / network errors → rethrow so the queue applies backoff and retries.
      throw err;
    }
  }
}
