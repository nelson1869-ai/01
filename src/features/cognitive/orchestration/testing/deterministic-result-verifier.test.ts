import { describe, expect, it } from "vitest";

import type { PersistedExecution } from "../../persistence/contracts/execution";
import type { PersistedObservation } from "../../persistence/contracts/persisted-observation";
import { DeterministicResultVerifier } from "./deterministic-result-verifier";

describe("deterministic result verifier", () => {
  const T0 = "2026-08-31T05:00:00.000Z";
  const verifier = new DeterministicResultVerifier("test-verifier-v1");

  const baseExecution: PersistedExecution = {
    executionId: "exec-1",
    sessionId: "sess-1",
    planId: "plan-1",
    status: "RUNNING",
    currentStepId: "step-1",
    safetyGenerationAtStart: 1,
    rowVersion: 1,
    createdAt: T0,
    updatedAt: T0,
    startedAt: T0,
    completedAt: null,
    error: null,
  };

  const createObs = (
    id: string,
    outcome: string,
    summary: string = "Summary",
  ): PersistedObservation => ({
    observationId: id,
    executionId: "exec-1",
    stepId: "step-1",
    source: "provider-dispatch",
    sourceEventId: "evt-1",
    summary,
    data: { outcome },
    observedAt: T0,
    payloadExpiresAt: null,
  });

  it("returns VERIFIED when observation confirms operation success", () => {
    const output = verifier.verify({
      execution: baseExecution,
      observations: [createObs("obs-1", "CONFIRMED_SUCCESS")],
    });

    expect(output.status).toBe("VERIFIED");
    expect(output.confidence).toBe(1.0);
  });

  it("returns FAILED when observation confirms deterministic failure", () => {
    const output = verifier.verify({
      execution: baseExecution,
      observations: [
        createObs(
          "obs-1",
          "CONFIRMED_FAILURE",
          "Permanent provider failure",
        ),
      ],
    });

    expect(output.status).toBe("FAILED");
    expect(output.confidence).toBe(1.0);
  });

  it("returns FAILED when observation confirms operation was not applied", () => {
    const output = verifier.verify({
      execution: baseExecution,
      observations: [createObs("obs-1", "CONFIRMED_NOT_APPLIED")],
    });

    expect(output.status).toBe("FAILED");
    expect(output.confidence).toBe(1.0);
  });

  it("returns INCONCLUSIVE when observation is indeterminate", () => {
    const output = verifier.verify({
      execution: baseExecution,
      observations: [createObs("obs-1", "INDETERMINATE")],
    });

    expect(output.status).toBe("INCONCLUSIVE");
    expect(output.confidence).toBe(0.5);
  });

  it("returns INCONCLUSIVE when no observations provided", () => {
    const output = verifier.verify({
      execution: baseExecution,
      observations: [],
    });

    expect(output.status).toBe("INCONCLUSIVE");
  });
});
