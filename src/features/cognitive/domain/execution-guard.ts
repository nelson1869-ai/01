import type { ExecutionSafetyState } from "./execution-safety";

export function assertAutonomousExecutionAllowed(
  safety: ExecutionSafetyState,
): void {
  if (safety.status !== "ALLOWED") {
    throw new Error(
      "Autonomous execution is blocked by the execution safety gate.",
    );
  }
}
