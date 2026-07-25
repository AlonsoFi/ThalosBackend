import { MilestoneSyncService, MilestoneSyncPayload } from './milestone-sync.service';
import { RetryJobType } from '../retry-queue/retry-queue.types';
import { TrustlessRelayError } from '../internal-trustless/escrow-write.helper';

// ---------------------------------------------------------------------------
// Mock the standalone TW write helpers so tests never hit the network.
// ---------------------------------------------------------------------------
jest.mock('../internal-trustless/escrow-write.helper', () => ({
  approveMilestone: jest.fn(),
  changeMilestoneStatus: jest.fn(),
  TrustlessRelayError: jest.requireActual('../internal-trustless/escrow-write.helper')
    .TrustlessRelayError,
}));

import {
  approveMilestone,
  changeMilestoneStatus,
} from '../internal-trustless/escrow-write.helper';

const mockApproveMilestone = approveMilestone as jest.Mock;
const mockChangeMilestoneStatus = changeMilestoneStatus as jest.Mock;

// ---------------------------------------------------------------------------
// Factory — builds a MilestoneSyncService with mocked RetryQueueService
// ---------------------------------------------------------------------------

function buildService() {
  const registerHandler = jest.fn();
  const enqueue = jest.fn().mockResolvedValue({ id: 'job-1' });
  const retryQueue = { registerHandler, enqueue } as unknown as InstanceType<
    typeof import('../retry-queue/retry-queue.service').RetryQueueService
  >;

  const svc = new MilestoneSyncService(retryQueue);
  return { svc, registerHandler, enqueue };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(overrides: Partial<MilestoneSyncPayload> = {}): MilestoneSyncPayload {
  return {
    contractId: 'CONTRACT-001',
    agreementType: 'single',
    milestoneIndex: '0',
    action: 'approve',
    approver: 'GAPPROVER',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MilestoneSyncService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── onModuleInit ─────────────────────────────────────────────────────────

  describe('onModuleInit', () => {
    it('registers the MILESTONE_UPDATE handler in the shared retry queue', () => {
      const { svc, registerHandler } = buildService();
      svc.onModuleInit();
      expect(registerHandler).toHaveBeenCalledWith(
        RetryJobType.MILESTONE_UPDATE,
        expect.any(Function),
      );
    });
  });

  // ─── toTWServiceType ──────────────────────────────────────────────────────

  describe('toTWServiceType', () => {
    it('maps "single" → "single-release"', () => {
      const { svc } = buildService();
      expect(svc.toTWServiceType('single')).toBe('single-release');
    });

    it('maps "multi" → "multi-release"', () => {
      const { svc } = buildService();
      expect(svc.toTWServiceType('multi')).toBe('multi-release');
    });
  });

  // ─── detectConflict ───────────────────────────────────────────────────────

  describe('detectConflict', () => {
    it('returns false when local and TW statuses match', () => {
      const { svc } = buildService();
      expect(svc.detectConflict('approved', 'approved')).toBe(false);
    });

    it('returns false when both statuses are non-terminal', () => {
      const { svc } = buildService();
      expect(svc.detectConflict('pending', 'pending')).toBe(false);
    });

    it('returns false when local is already terminal and TW is terminal', () => {
      const { svc } = buildService();
      expect(svc.detectConflict('released', 'approved')).toBe(false);
    });

    it('returns true when TW is terminal but local is not — "approved" vs "pending"', () => {
      const { svc } = buildService();
      expect(svc.detectConflict('pending', 'approved')).toBe(true);
    });

    it('returns true when TW is "released" but local is "pending"', () => {
      const { svc } = buildService();
      expect(svc.detectConflict('pending', 'released')).toBe(true);
    });
  });

  // ─── applyTWMilestoneUpdate ───────────────────────────────────────────────

  describe('applyTWMilestoneUpdate', () => {
    it('returns "skipped" when local status already matches TW status (idempotent)', () => {
      const { svc } = buildService();
      expect(svc.applyTWMilestoneUpdate({ currentLocalStatus: 'approved', twStatus: 'approved' })).toBe(
        'skipped',
      );
    });

    it('returns "conflict" when detectConflict is true', () => {
      const { svc } = buildService();
      expect(svc.applyTWMilestoneUpdate({ currentLocalStatus: 'pending', twStatus: 'approved' })).toBe(
        'conflict',
      );
    });

    it('returns "applied" for a valid non-conflicting transition', () => {
      const { svc } = buildService();
      // pending → released is valid (not a backward move, just different)
      expect(svc.applyTWMilestoneUpdate({ currentLocalStatus: 'pending', twStatus: 'rejected' })).toBe(
        'applied',
      );
    });
  });

  // ─── pushMilestoneToTW ────────────────────────────────────────────────────

  describe('pushMilestoneToTW', () => {
    describe('approve action', () => {
      it('calls approveMilestone with single-release serviceType for a "single" agreement', async () => {
        const { svc } = buildService();
        const unsignedTransaction = 'XDR_UNSIGNED_001';
        mockApproveMilestone.mockResolvedValue({ unsignedTransaction });

        const result = await svc.pushMilestoneToTW(
          makePayload({ agreementType: 'single', action: 'approve', approver: 'GAPPROVER' }),
        );

        expect(mockApproveMilestone).toHaveBeenCalledWith({
          contractId: 'CONTRACT-001',
          milestoneIndex: '0',
          approver: 'GAPPROVER',
          type: 'single-release',
        });
        expect(result).toEqual({ unsignedTransaction });
      });

      it('calls approveMilestone with multi-release serviceType for a "multi" agreement', async () => {
        const { svc } = buildService();
        mockApproveMilestone.mockResolvedValue({ unsignedTransaction: 'XDR_MULTI' });

        await svc.pushMilestoneToTW(
          makePayload({ agreementType: 'multi', action: 'approve', approver: 'GAPPROVER' }),
        );

        expect(mockApproveMilestone).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'multi-release' }),
        );
      });

      it('returns { unsignedTransaction } without marking sync succeeded', async () => {
        const { svc } = buildService();
        mockApproveMilestone.mockResolvedValue({ unsignedTransaction: 'XDR_PENDING' });

        const result = await svc.pushMilestoneToTW(makePayload());

        // The returned object is purely the TW response — no extra fields added
        expect(result).toEqual({ unsignedTransaction: 'XDR_PENDING' });
        expect(result).not.toHaveProperty('syncSucceeded');
      });
    });

    describe('change_status action', () => {
      it('calls changeMilestoneStatus with the correct serviceType for a "multi" agreement', async () => {
        const { svc } = buildService();
        mockChangeMilestoneStatus.mockResolvedValue({ unsignedTransaction: 'XDR_CHANGE' });

        await svc.pushMilestoneToTW(
          makePayload({
            agreementType: 'multi',
            action: 'change_status',
            serviceProvider: 'GPROVIDER',
            newStatus: 'rejected',
            newEvidence: 'evidence-url',
          }),
        );

        expect(mockChangeMilestoneStatus).toHaveBeenCalledWith({
          contractId: 'CONTRACT-001',
          milestoneIndex: '0',
          newStatus: 'rejected',
          newEvidence: 'evidence-url',
          serviceProvider: 'GPROVIDER',
          type: 'multi-release',
        });
      });
    });
  });

  // ─── enqueueRetry ─────────────────────────────────────────────────────────

  describe('enqueueRetry', () => {
    it('calls retryQueue.enqueue with MILESTONE_UPDATE job type and idempotency key', async () => {
      const { svc, enqueue } = buildService();
      const payload = makePayload();
      const key = 'idem-key-abc';

      await svc.enqueueRetry(payload, key);

      expect(enqueue).toHaveBeenCalledWith(RetryJobType.MILESTONE_UPDATE, payload, key);
    });
  });

  // ─── handleMilestoneUpdateJob (via retry queue handler) ───────────────────

  describe('handleMilestoneUpdateJob (retry handler)', () => {
    it('re-attempts pushMilestoneToTW successfully', async () => {
      const { svc, registerHandler } = buildService();
      mockApproveMilestone.mockResolvedValue({ unsignedTransaction: 'XDR' });
      svc.onModuleInit();

      // Extract the registered handler and call it directly
      const handler: (p: MilestoneSyncPayload) => Promise<void> =
        registerHandler.mock.calls[0][1];

      await expect(handler(makePayload())).resolves.not.toThrow();
    });

    it('swallows 4xx TrustlessRelayError (non-retryable validation failure)', async () => {
      const { svc, registerHandler } = buildService();
      mockApproveMilestone.mockRejectedValue(new TrustlessRelayError(400, { error: 'Bad param' }));
      svc.onModuleInit();

      const handler: (p: MilestoneSyncPayload) => Promise<void> =
        registerHandler.mock.calls[0][1];

      // Should NOT throw — 4xx is not retryable
      await expect(handler(makePayload())).resolves.not.toThrow();
    });

    it('rethrows 5xx TrustlessRelayError so the queue applies backoff', async () => {
      const { svc, registerHandler } = buildService();
      mockApproveMilestone.mockRejectedValue(new TrustlessRelayError(503, { error: 'Unavailable' }));
      svc.onModuleInit();

      const handler: (p: MilestoneSyncPayload) => Promise<void> =
        registerHandler.mock.calls[0][1];

      await expect(handler(makePayload())).rejects.toBeInstanceOf(TrustlessRelayError);
    });
  });
});
