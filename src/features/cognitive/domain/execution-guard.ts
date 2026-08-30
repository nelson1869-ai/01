import type {
  AllowedExecutionSafetyState,
  ExecutionSafetyState,
} from "./execution-safety";
import { isAllowedExecutionSafetyState } from "./execution-safety";

export function assertAutonomousExecutionAllowed(
  authorization: ExecutionSafetyState,
  currentSafety: ExecutionSafetyState,
): asserts authorization is AllowedExecutionSafetyState {
  if (!isAllowedExecutionSafetyState(authorization)) {
    throw new Error(
      "Autonomous execution is blocked by the execution safety gate.",
    );
  }

  if (authorization.generation !== currentSafety.generation) {
    throw new Error("Autonomous execution authorization is stale.");
  }

  if (!isAllowedExecutionSafetyState(currentSafety)) {
    throw new Error(
      "Autonomous execution is blocked by the current execution safety state.",
    );
  }

  if (authorization.candidateId !== currentSafety.candidateId) {
    throw new Error("Autonomous execution authorization is stale.");
  }
}
