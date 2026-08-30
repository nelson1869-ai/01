import { describe, expect, it } from "vitest";

import {
  allowAutonomousExecution,
  createInitialExecutionSafetyState,
  type ExecutionSafetyState,
} from "../domain/execution-safety";
import { assertLiveExecutionAuthorization } from "./execution-authorization-guard";

function createAuthorization() {
  return allowAutonomousExecution(
    createInitialExecutionSafetyState(),
    { phase: "POLICY_SAFETY" },
    { candidateId: "candidate-1", status: "VERIFIED" },
    { candidateId: "candidate-1", outcome: "ALLOW" },
  );
}

describe("trusted execution authorization guard", () => {
  it("accepts the real private-branded capability at its exact generation", () => {
    const authorization = createAuthorization();
    expect(() =>
      assertLiveExecutionAuthorization(
        authorization,
        authorization.generation,
      ),
    ).not.toThrow();
  });

  it("rejects a forged object that merely claims ALLOWED", () => {
    const forged = {
      status: "ALLOWED",
      generation: 1,
      candidateId: "candidate-1",
      failure: null,
      reason: null,
      blockedAt: null,
    } as unknown as ExecutionSafetyState;

    expect(() => assertLiveExecutionAuthorization(forged, 1)).toThrow(
      "private-branded",
    );
  });

  it("rejects a spread-cloned capability because its private brand is absent", () => {
    const cloned = { ...createAuthorization() };
    expect(() => assertLiveExecutionAuthorization(cloned, 1)).toThrow(
      "private-branded",
    );
  });

  it("rejects a real but stale capability", () => {
    const authorization = createAuthorization();
    expect(() => assertLiveExecutionAuthorization(authorization, 2)).toThrow(
      "does not match expected generation",
    );
  });
});
