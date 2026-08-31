import { describe, expect, it } from "vitest";

import type { PersistedCognitiveSession } from "../persistence/contracts/cognitive-session";
import type { PersistedCueIngress } from "../persistence/contracts/cue-ingress";
import { PersistenceError } from "../persistence/postgres/errors/persistence-errors";
import { mapPersistedCueToDomainCue } from "../persistence/postgres/utils/row-mappers";
import { inspectRecoveryState } from "./recovery-orchestrator";

describe("recovery orchestrator unit tests", () => {
  const baseSession: PersistedCognitiveSession = {
    sessionId: "sess-orch-1",
    cueId: "cue-orch-1",
    phase: "COOLDOWN",
    failureCount: 2,
    retryCount: 0,
    maxRetries: 3,
    evaluationGeneration: 1,
    cooldownUntil: "2026-08-31T00:04:00.000Z",
    currentCandidateId: null,
    currentPlanId: null,
    currentExecutionId: null,
    rowVersion: 2,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:01.000Z",
  };

  it("1. mapPersistedCueToDomainCue maps fields precisely without inventing properties", () => {
    const persisted: PersistedCueIngress = {
      cueId: "cue-123",
      source: "github",
      externalEventId: "evt-999",
      type: "github.issue.created",
      occurredAt: "2026-08-31T00:00:00.000Z",
      receivedAt: "2026-08-31T00:00:01.000Z",
      payload: { issueNumber: 42, title: "Bug fix" },
    };

    const domainCue = mapPersistedCueToDomainCue(persisted);
    expect(domainCue).toEqual({
      id: "cue-123",
      type: "github.issue.created",
      source: "github",
      occurredAt: "2026-08-31T00:00:00.000Z",
      payload: { issueNumber: 42, title: "Bug fix" },
    });
    expect("externalEventId" in domainCue).toBe(false);
    expect("receivedAt" in domainCue).toBe(false);
  });

  it("2. classifies pre-deadline session as COOLDOWN_ACTIVE with exact remaining ms", () => {
    const result = inspectRecoveryState(
      baseSession,
      "2026-08-31T00:02:00.000Z", // 2 minutes before 00:04:00
    );

    expect(result.status).toBe("COOLDOWN_ACTIVE");
    if (result.status === "COOLDOWN_ACTIVE") {
      expect(result.sessionId).toBe("sess-orch-1");
      expect(result.cooldownUntil).toBe("2026-08-31T00:04:00.000Z");
      expect(result.remainingMs).toBe(120000);
    }
  });

  it("3. classifies exact deadline boundary as COOLDOWN_READY", () => {
    const result = inspectRecoveryState(
      baseSession,
      "2026-08-31T00:04:00.000Z", // Exact boundary
    );

    expect(result.status).toBe("COOLDOWN_READY");
    if (result.status === "COOLDOWN_READY") {
      expect(result.sessionId).toBe("sess-orch-1");
      expect(result.readyAt).toBe("2026-08-31T00:04:00.000Z");
    }
  });

  it("4. classifies post-deadline session as COOLDOWN_READY", () => {
    const result = inspectRecoveryState(
      baseSession,
      "2026-08-31T00:05:00.000Z", // 1 minute past
    );

    expect(result.status).toBe("COOLDOWN_READY");
  });

  it("5. classifies HUMAN_REVIEW session as HUMAN_REVIEW_REQUIRED and forbids auto-resume", () => {
    const humanReviewSession: PersistedCognitiveSession = {
      ...baseSession,
      phase: "HUMAN_REVIEW",
      cooldownUntil: null,
      failureCount: 3,
    };

    const result = inspectRecoveryState(
      humanReviewSession,
      "2026-08-31T00:10:00.000Z",
    );

    expect(result.status).toBe("HUMAN_REVIEW_REQUIRED");
    if (result.status === "HUMAN_REVIEW_REQUIRED") {
      expect(result.failureCount).toBe(3);
      expect(result.reason).toContain("human review");
    }
  });

  it("6. classifies normal active phases as NO_RECOVERY_ACTION", () => {
    const activeSession: PersistedCognitiveSession = {
      ...baseSession,
      phase: "BUILD_CONTEXT",
      cooldownUntil: null,
    };

    const result = inspectRecoveryState(
      activeSession,
      "2026-08-31T00:05:00.000Z",
    );

    expect(result.status).toBe("NO_RECOVERY_ACTION");
    if (result.status === "NO_RECOVERY_ACTION") {
      expect(result.phase).toBe("BUILD_CONTEXT");
    }
  });

  it("7. throws invalidPersistedState if COOLDOWN session lacks cooldownUntil", () => {
    const badSession: PersistedCognitiveSession = {
      ...baseSession,
      phase: "COOLDOWN",
      cooldownUntil: null,
    };

    expect(() =>
      inspectRecoveryState(badSession, "2026-08-31T00:05:00.000Z"),
    ).toThrow(PersistenceError);
  });
});
