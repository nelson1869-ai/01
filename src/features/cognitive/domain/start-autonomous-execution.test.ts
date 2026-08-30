import { describe, expect, it } from "vitest";

import { startAutonomousExecution } from "./start-autonomous-execution";
import type { ExecutionSafetyState } from "./execution-safety";
import type { ExecutionRecord } from "./execution";

describe("startAutonomousExecution", () => {
  // ============================================================
  // TEST 1: PENDING + ALLOWED → RUNNING
  // ============================================================
  it("starts a pending execution when autonomous execution is allowed", () => {
    const execution: ExecutionRecord = {
      id: "execution-1",
      planId: "plan-1",
      status: "PENDING",
      currentStepId: null,
      startedAt: null,
      completedAt: null,
      error: null,
    };

    const safety: ExecutionSafetyState = {
      status: "ALLOWED",
      failure: null,
      reason: null,
      blockedAt: null,
    };

    const result = startAutonomousExecution(
      execution,
      safety,
      "2026-08-30T16:00:00.000Z",
    );

    expect(result).toEqual({
      id: "execution-1",
      planId: "plan-1",
      status: "RUNNING",
      currentStepId: null,
      startedAt: "2026-08-30T16:00:00.000Z",
      completedAt: null,
      error: null,
    });
  });

  // ============================================================
  // TEST 2: BLOCKED SAFETY → DO NOT START
  // ============================================================
  it("rejects execution when autonomous execution is blocked", () => {
    const execution: ExecutionRecord = {
      id: "execution-1",
      planId: "plan-1",
      status: "PENDING",
      currentStepId: null,
      startedAt: null,
      completedAt: null,
      error: null,
    };

    const safety: ExecutionSafetyState = {
      status: "BLOCKED",
      failure: "HALLUCINATION_DETECTED",
      reason: "Grounding failed.",
      blockedAt: "2026-08-30T15:59:00.000Z",
    };

    expect(() =>
      startAutonomousExecution(execution, safety, "2026-08-30T16:00:00.000Z"),
    ).toThrow("Autonomous execution is blocked by the execution safety gate.");
  });

  // ============================================================
  // TEST 3: NON-PENDING EXECUTION → DO NOT START AGAIN
  // ============================================================
  it("rejects an execution that is already running", () => {
    const execution: ExecutionRecord = {
      id: "execution-1",
      planId: "plan-1",
      status: "RUNNING",
      currentStepId: null,
      startedAt: "2026-08-30T15:59:00.000Z",
      completedAt: null,
      error: null,
    };

    const safety: ExecutionSafetyState = {
      status: "ALLOWED",
      failure: null,
      reason: null,
      blockedAt: null,
    };

    expect(() =>
      startAutonomousExecution(execution, safety, "2026-08-30T16:00:00.000Z"),
    ).toThrow("Only a pending execution can be started.");
  });
});
