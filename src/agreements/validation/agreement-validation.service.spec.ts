import { Test, TestingModule } from "@nestjs/testing";
import { AgreementValidationService } from "./agreement-validation.service";

describe("AgreementValidationService", () => {
  let service: AgreementValidationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AgreementValidationService],
    }).compile();

    service = module.get<AgreementValidationService>(AgreementValidationService);
  });

  describe("validateTransition", () => {
    // ── Valid transitions ────────────────────────────────────────────────

    it.each([
      ["pending", "funded"],
      ["pending", "cancelled"],
      ["funded", "active"],
      ["funded", "cancelled"],
      ["active", "completed"],
      ["active", "in_review"],
      ["active", "disputed"],
      ["active", "cancelled"],
      ["in_review", "completed"],
      ["in_review", "disputed"],
      ["disputed", "resolved"],
      ["disputed", "active"],
      ["disputed", "cancelled"],
    ])('should allow valid transition "%s" → "%s"', (from, to) => {
      const result = service.validateTransition(from, to);
      expect(result).toEqual({ valid: true });
    });

    // ── Invalid transitions ──────────────────────────────────────────────

    it.each([
      ["pending", "completed"],
      ["pending", "active"],
      ["pending", "disputed"],
      ["pending", "resolved"],
      ["funded", "completed"],
      ["funded", "disputed"],
      ["funded", "resolved"],
      ["active", "resolved"],
      ["active", "funded"],
      ["completed", "pending"],
      ["completed", "funded"],
      ["completed", "active"],
      ["cancelled", "pending"],
      ["cancelled", "funded"],
      ["cancelled", "active"],
      ["resolved", "pending"],
      ["resolved", "active"],
      ["disputed", "completed"],
      ["disputed", "funded"],
    ])('should reject invalid transition "%s" → "%s"', (from, to) => {
      const result = service.validateTransition(from, to);
      expect(result).toEqual({
        valid: false,
        reason: expect.stringContaining("Invalid transition"),
      });
    });

    // ── Same-status transitions ──────────────────────────────────────────

    it.each([
      ["pending", "pending"],
      ["active", "active"],
      ["completed", "completed"],
    ])('should reject same-status transition "%s" → "%s"', (from, to) => {
      const result = service.validateTransition(from, to);
      expect(result).toEqual({
        valid: false,
        reason: expect.stringContaining("no-op"),
      });
    });

    // ── Unknown statuses ─────────────────────────────────────────────────

    it('should reject unknown source status', () => {
      const result = service.validateTransition("unknown", "pending");
      expect(result).toEqual({
        valid: false,
        reason: expect.stringContaining('Unknown source status: "unknown"'),
      });
    });

    it('should reject unknown target status', () => {
      const result = service.validateTransition("pending", "unknown");
      expect(result).toEqual({
        valid: false,
        reason: expect.stringContaining('Unknown target status: "unknown"'),
      });
    });

    // ── Terminal states ──────────────────────────────────────────────────

    it("completed should be terminal (no transitions out)", () => {
      const allowed = service.getAllowedTransitions("completed");
      expect(allowed).toEqual([]);
    });

    it("cancelled should be terminal (no transitions out)", () => {
      const allowed = service.getAllowedTransitions("cancelled");
      expect(allowed).toEqual([]);
    });

    it("resolved should be terminal (no transitions out)", () => {
      const allowed = service.getAllowedTransitions("resolved");
      expect(allowed).toEqual([]);
    });
  });

  describe("getAllowedTransitions", () => {
    it("should return allowed targets for pending", () => {
      expect(service.getAllowedTransitions("pending")).toEqual([
        "funded",
        "cancelled",
      ]);
    });

    it("should return empty array for unknown status", () => {
      expect(service.getAllowedTransitions("unknown")).toEqual([]);
    });
  });

  describe("getTransitionMap", () => {
    it("should return all transitions with correct keys", () => {
      const map = service.getTransitionMap();
      expect(Object.keys(map).sort()).toEqual([
        "active",
        "cancelled",
        "completed",
        "disputed",
        "funded",
        "in_review",
        "pending",
        "resolved",
      ]);
    });

    it('pending should transition to funded and cancelled', () => {
      const map = service.getTransitionMap();
      expect(map.pending).toEqual(["funded", "cancelled"]);
    });
  });
});
