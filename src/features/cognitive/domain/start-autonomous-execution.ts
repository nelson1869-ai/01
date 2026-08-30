import { assertAutonomousExecutionAllowed } from "./execution-guard";
import type { ExecutionSafetyState } from "./execution-safety";
import type { ExecutionRecord } from "./execution";

export function startAutonomousExecution(
  execution: ExecutionRecord,
  safety: ExecutionSafetyState,
  startedAt: string,
): ExecutionRecord {
  // ============================================================
  // 1. SAFETY GATE
  // ============================================================
  // Never start an autonomous action unless the safety gate
  // explicitly says execution is allowed.
  assertAutonomousExecutionAllowed(safety);

  // ============================================================
  // 2. VALID STATE TRANSITION
  // ============================================================
  // An execution can only start once.
  if (execution.status !== "PENDING") {
    throw new Error("Only a pending execution can be started.");
  }

  // ============================================================
  // 3. START EXECUTION
  // ============================================================
  return {
    ...execution,
    status: "RUNNING",
    startedAt,
    completedAt: null,
    error: null,
  };
}
