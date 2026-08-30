import { describe, expect, it } from "vitest";

import { assertAutonomousExecutionAllowed } from "./execution-guard";
import type { ExecutionSafetyState } from "./execution-safety";

describe("assertAutonomousExecutionAllowed", () => {
  it("allows execution when the safety state is ALLOWED", () => {
    const safety: ExecutionSafetyState = {
      status: "ALLOWED",
      failure: null,
      reason: null,
      blockedAt: null,
    };

    expect(() => assertAutonomousExecutionAllowed(safety)).not.toThrow();
  });

  it("blocks execution when the safety state is BLOCKED", () => {
    const safety: ExecutionSafetyState = {
      status: "BLOCKED",
      failure: "HALLUCINATION_DETECTED",
      reason: "Grounding failed.",
      blockedAt: "2026-08-30T15:45:00.000Z",
    };

    expect(() => assertAutonomousExecutionAllowed(safety)).toThrow(
      "Autonomous execution is blocked by the execution safety gate.",
    );
  });
});
