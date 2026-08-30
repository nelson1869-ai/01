import { describe, expect, it } from "vitest";

import type { StoredExecutionSafety } from "../../contracts/execution-safety";
import {
  mapPersistedGroundingStatusToDomain,
  mapPersistedPolicyOutcomeToDomain,
  mapStoredSafetyToDomain,
} from "./enum-mappers";

describe("enum mappers unit tests", () => {
  it("1. maps persisted grounding status to domain GroundingStatus", () => {
    expect(mapPersistedGroundingStatusToDomain("VERIFIED")).toBe("VERIFIED");
    expect(mapPersistedGroundingStatusToDomain("CONTRADICTED")).toBe(
      "CONFLICTING_EVIDENCE",
    );
    expect(mapPersistedGroundingStatusToDomain("UNVERIFIED")).toBe(
      "INSUFFICIENT_EVIDENCE",
    );
  });

  it("2. maps persisted policy outcome to domain PolicyOutcome", () => {
    expect(mapPersistedPolicyOutcomeToDomain("ALLOW")).toBe("ALLOW");
    expect(
      mapPersistedPolicyOutcomeToDomain("REQUIRE_HUMAN_CONFIRMATION"),
    ).toBe("REQUIRE_APPROVAL");
    expect(mapPersistedPolicyOutcomeToDomain("DENY")).toBe("DENY");
  });

  it("3. maps stored safety state UNAUTHORIZED to domain", () => {
    const stored: StoredExecutionSafety = {
      sessionId: "sess-1",
      generation: 0,
      status: "UNAUTHORIZED",
      failure: null,
      reason: "Initial safety",
      blockedAt: null,
      evaluatedCandidateId: null,
      groundingResultId: null,
      policyDecisionId: null,
      updatedAt: "2026-08-31T00:00:00.000Z",
    };

    const domain = mapStoredSafetyToDomain(stored);
    expect(domain.status).toBe("UNAUTHORIZED");
    expect(domain.generation).toBe(0);
    expect(domain.candidateId).toBeNull();
    expect(domain.failure).toBeNull();
    expect(domain.blockedAt).toBeNull();
  });

  it("4. maps stored safety state BLOCKED to domain", () => {
    const stored: StoredExecutionSafety = {
      sessionId: "sess-1",
      generation: 2,
      status: "BLOCKED",
      failure: "EXECUTION_TIMEOUT",
      reason: "Timeout failure",
      blockedAt: "2026-08-31T00:02:00.000Z",
      evaluatedCandidateId: null,
      groundingResultId: null,
      policyDecisionId: null,
      updatedAt: "2026-08-31T00:02:00.000Z",
    };

    const domain = mapStoredSafetyToDomain(stored);
    expect(domain.status).toBe("BLOCKED");
    expect(domain.generation).toBe(2);
    expect(domain.failure).toBe("EXECUTION_TIMEOUT");
    expect(domain.blockedAt).toBe("2026-08-31T00:02:00.000Z");
  });

  it("5. throws if stored BLOCKED safety lacks failure or blockedAt", () => {
    const badStored: StoredExecutionSafety = {
      sessionId: "sess-1",
      generation: 2,
      status: "BLOCKED",
      failure: null as unknown as "EXECUTION_TIMEOUT",
      reason: "Broken row",
      blockedAt: null as unknown as string,
      evaluatedCandidateId: null,
      groundingResultId: null,
      policyDecisionId: null,
      updatedAt: "2026-08-31T00:02:00.000Z",
    };

    expect(() => mapStoredSafetyToDomain(badStored)).toThrow();
  });
});
