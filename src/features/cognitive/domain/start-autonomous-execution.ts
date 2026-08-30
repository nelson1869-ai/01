import { assertAutonomousExecutionAllowed } from "./execution-guard";
import type { ActionPlan } from "./action-plan";
import type { ExecutionSafetyState } from "./execution-safety";
import type { ExecutionRecord } from "./execution";

export function startAutonomousExecution(
  execution: ExecutionRecord,
  plan: ActionPlan,
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
  // 2. AUTHORIZATION BINDING
  // ============================================================
  if (safety.candidateId !== plan.candidateId) {
    throw new Error(
      "Execution authorization and plan must reference the same candidate.",
    );
  }

  if (execution.planId !== plan.id) {
    throw new Error("Execution record and plan must reference the same plan.");
  }

  // ============================================================
  // 3. VALID STATE TRANSITION
  // ============================================================
  // An execution can only start once.
  if (execution.status !== "PENDING") {
    throw new Error("Only a pending execution can be started.");
  }

  // ============================================================
  // 4. START EXECUTION
  // ============================================================
  return {
    ...execution,
    status: "RUNNING",
    startedAt,
    completedAt: null,
    error: null,
  };
}
