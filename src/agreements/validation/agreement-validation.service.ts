import { Injectable, Logger } from "@nestjs/common";

/**
 * Known lifecycle statuses for Thalos agreements.
 * Maps to Trustless Work statuses via the sync engine.
 */
export type AgreementStatus =
  | "pending"
  | "funded"
  | "active"
  | "in_review"
  | "completed"
  | "cancelled"
  | "disputed"
  | "resolved";

/** Centralized valid transition map — single source of truth. */
const VALID_TRANSITIONS: Record<AgreementStatus, AgreementStatus[]> = {
  pending:  ["funded", "cancelled"],
  funded:   ["active", "cancelled"],
  active:   ["completed", "in_review", "disputed", "cancelled"],
  in_review:["completed", "disputed"],
  completed:[],          // terminal
  cancelled:[],          // terminal
  disputed: ["resolved", "active", "cancelled"],
  resolved: [],          // terminal
};

@Injectable()
export class AgreementValidationService {
  private readonly logger = new Logger(AgreementValidationService.name);

  /**
   * Validate a state transition.
   * Returns `{ valid: true }` or `{ valid: false, reason: "..." }`.
   */
  validateTransition(
    from: string,
    to: string,
  ): { valid: true } | { valid: false; reason: string } {
    if (!(from in VALID_TRANSITIONS)) {
      return { valid: false, reason: `Unknown source status: "${from}"` };
    }
    if (!(to in VALID_TRANSITIONS)) {
      return { valid: false, reason: `Unknown target status: "${to}"` };
    }

    const fromStatus = from as AgreementStatus;
    const toStatus = to as AgreementStatus;

    if (from === to) {
      return { valid: false, reason: `Transition to the same status ("${from}" → "${to}") is a no-op` };
    }

    const allowed = VALID_TRANSITIONS[fromStatus];
    if (!allowed.includes(toStatus)) {
      return {
        valid: false,
        reason: `Invalid transition: "${from}" → "${to}". Allowed targets: ${allowed.join(", ") || "(none — terminal state)"}`,
      };
    }

    return { valid: true };
  }

  /** Get all valid next statuses from a given status. */
  getAllowedTransitions(from: string): AgreementStatus[] {
    return VALID_TRANSITIONS[from as AgreementStatus] ?? [];
  }

  /** Get the full transition map (for diagnostics). */
  getTransitionMap(): Record<string, string[]> {
    const map: Record<string, string[]> = {};
    for (const [from, to] of Object.entries(VALID_TRANSITIONS)) {
      map[from] = [...to];
    }
    return map;
  }
}
