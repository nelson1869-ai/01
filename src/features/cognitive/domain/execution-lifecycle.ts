import type { ExecutionStatus } from "./execution";

const legalExecutionTransitions: Readonly<
  Record<"PENDING" | "RUNNING", readonly ExecutionStatus[]>
> = {
  PENDING: ["RUNNING", "CANCELLED", "BLOCKED"],
  RUNNING: ["SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED"],
};

export function isLegalExecutionTransition(
  from: ExecutionStatus,
  to: ExecutionStatus,
): boolean {
  if (from !== "PENDING" && from !== "RUNNING") {
    return false;
  }

  return legalExecutionTransitions[from].includes(to);
}

export function isLegalExecutionStepTransition(
  from: ExecutionStatus,
  to: ExecutionStatus,
): boolean {
  return isLegalExecutionTransition(from, to);
}

export type ExecutionOperationStatus =
  | "PENDING"
  | "IN_FLIGHT"
  | "SUCCEEDED"
  | "FAILED"
  | "UNKNOWN";

export function isLegalExecutionOperationTransition(
  from: ExecutionOperationStatus,
  to: ExecutionOperationStatus,
): boolean {
  if (from === "PENDING") {
    return to === "IN_FLIGHT";
  }

  if (from === "IN_FLIGHT") {
    return to === "SUCCEEDED" || to === "FAILED" || to === "UNKNOWN";
  }

  return false;
}

export function nextExecutionTransitionSequence(rowVersion: number): number {
  if (
    !Number.isSafeInteger(rowVersion) ||
    rowVersion < 0 ||
    rowVersion >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("Execution row version cannot advance safely.");
  }

  return rowVersion + 1;
}

export type ReadinessStep = Readonly<{
  stepId: string;
  ordinal: number;
  status: ExecutionStatus;
}>;

export type ReadinessDependency = Readonly<{
  stepId: string;
  dependsOnStepId: string;
}>;

export function selectReadyExecutionSteps(
  steps: readonly ReadinessStep[],
  dependencies: readonly ReadinessDependency[],
): readonly ReadinessStep[] {
  const statusByStepId = new Map(steps.map((step) => [step.stepId, step.status]));
  const dependenciesByStepId = new Map<string, string[]>();

  for (const dependency of dependencies) {
    const existing = dependenciesByStepId.get(dependency.stepId) ?? [];
    existing.push(dependency.dependsOnStepId);
    dependenciesByStepId.set(dependency.stepId, existing);
  }

  return steps
    .filter((step) => {
      if (step.status !== "PENDING") {
        return false;
      }

      const requiredStepIds = dependenciesByStepId.get(step.stepId) ?? [];
      return requiredStepIds.every(
        (dependencyId) => statusByStepId.get(dependencyId) === "SUCCEEDED",
      );
    })
    .sort(
      (left, right) =>
        left.ordinal - right.ordinal || left.stepId.localeCompare(right.stepId),
    );
}
