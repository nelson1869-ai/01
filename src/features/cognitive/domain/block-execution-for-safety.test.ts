import { describe, expect, it } from "vitest";

import { blockExecutionForSafety } from "./block-execution-for-safety";
import type { ExecutionRecord } from "./execution";

describe("blockExecutionForSafety", () => {
  // ============================================================
  // TEST 1: RUNNING → BLOCKED
  // ============================================================
  it("blocks a running execution and preserves execution evidence", () => {
    const execution: ExecutionRecord = {
      id: "execution-1",
      planId: "plan-1",
      status: "RUNNING",

      // Preserve where execution was interrupted.
      currentStepId: "step-3",

      startedAt: "2026-08-30T16:00:00.000Z",
      completedAt: null,
      error: null,
    };

    const result = blockExecutionForSafety(
      execution,
      "Hallucination detected during execution.",
      "2026-08-30T16:01:00.000Z",
    );

    expect(result).toEqual({
      id: "execution-1",
      planId: "plan-1",

      status: "BLOCKED",

      // Evidence of where execution stopped remains.
      currentStepId: "step-3",

      startedAt: "2026-08-30T16:00:00.000Z",

      // Safety-stop timestamp.
      completedAt: "2026-08-30T16:01:00.000Z",

      error: "Hallucination detected during execution.",
    });
  });

  // ============================================================
  // TEST 2: PENDING → BLOCKED
  // ============================================================
  it("blocks a pending execution before it starts", () => {
    const execution: ExecutionRecord = {
      id: "execution-2",
      planId: "plan-2",
      status: "PENDING",
      currentStepId: null,
      startedAt: null,
      completedAt: null,
      error: null,
    };

    const result = blockExecutionForSafety(
      execution,
      "Policy violation detected.",
      "2026-08-30T16:02:00.000Z",
    );

    expect(result.status).toBe("BLOCKED");

    // It never actually started.
    expect(result.startedAt).toBeNull();

    expect(result.completedAt).toBe("2026-08-30T16:02:00.000Z");

    expect(result.error).toBe("Policy violation detected.");
  });

  // ============================================================
  // TEST 3: TERMINAL EXECUTION CANNOT BE RE-BLOCKED
  // ============================================================
  it("rejects safety blocking for an already completed execution", () => {
    const execution: ExecutionRecord = {
      id: "execution-3",
      planId: "plan-3",
      status: "SUCCEEDED",
      currentStepId: "step-5",
      startedAt: "2026-08-30T16:00:00.000Z",
      completedAt: "2026-08-30T16:05:00.000Z",
      error: null,
    };

    expect(() =>
      blockExecutionForSafety(
        execution,
        "Late failure signal.",
        "2026-08-30T16:06:00.000Z",
      ),
    ).toThrow("Only a pending or running execution can be safety-blocked.");
  });
});
