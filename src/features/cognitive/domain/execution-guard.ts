import type {
  AllowedExecutionSafetyState,
  ExecutionSafetyState,
} from "./execution-safety";
import { isAllowedExecutionSafetyState } from "./execution-safety";

export function assertAutonomousExecutionAllowed(
  safety: ExecutionSafetyState,
): asserts safety is AllowedExecutionSafetyState {
  if (!isAllowedExecutionSafetyState(safety)) {
    throw new Error(
      "Autonomous execution is blocked by the execution safety gate.",
    );
  }
}
