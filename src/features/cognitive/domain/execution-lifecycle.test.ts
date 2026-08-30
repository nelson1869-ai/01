import { describe, expect, it } from "vitest";

import type { ExecutionStatus } from "./execution";
import {
  isLegalExecutionOperationTransition,
  isLegalExecutionStepTransition,
  isLegalExecutionTransition,
  nextExecutionTransitionSequence,
  selectReadyExecutionSteps,
  type ExecutionOperationStatus,
} from "./execution-lifecycle";

describe("execution lifecycle transition rules", () => {
  const legalExecutionTransitions: readonly [ExecutionStatus, ExecutionStatus][] = [
    ["PENDING", "RUNNING"],
    ["PENDING", "CANCELLED"],
    ["PENDING", "BLOCKED"],
    ["RUNNING", "SUCCEEDED"],
    ["RUNNING", "FAILED"],
    ["RUNNING", "CANCELLED"],
    ["RUNNING", "BLOCKED"],
  ];

  it.each(legalExecutionTransitions)(
    "allows execution %s -> %s",
    (from, to) => {
      expect(isLegalExecutionTransition(from, to)).toBe(true);
    },
  );

  it.each(legalExecutionTransitions)("allows step %s -> %s", (from, to) => {
    expect(isLegalExecutionStepTransition(from, to)).toBe(true);
  });

  it.each(["SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED"] as const)(
    "forbids every transition from terminal execution state %s",
    (from) => {
      for (const to of [
        "PENDING",
        "RUNNING",
        "SUCCEEDED",
        "FAILED",
        "CANCELLED",
        "BLOCKED",
      ] as const) {
        expect(isLegalExecutionTransition(from, to)).toBe(false);
        expect(isLegalExecutionStepTransition(from, to)).toBe(false);
      }
    },
  );

  it.each([
    ["PENDING", "IN_FLIGHT"],
    ["IN_FLIGHT", "SUCCEEDED"],
    ["IN_FLIGHT", "FAILED"],
    ["IN_FLIGHT", "UNKNOWN"],
  ] as const)("allows operation %s -> %s", (from, to) => {
    expect(isLegalExecutionOperationTransition(from, to)).toBe(true);
  });

  it("forbids direct PENDING outcomes and all terminal operation transitions", () => {
    expect(isLegalExecutionOperationTransition("PENDING", "SUCCEEDED")).toBe(
      false,
    );
    expect(isLegalExecutionOperationTransition("PENDING", "FAILED")).toBe(
      false,
    );
    expect(isLegalExecutionOperationTransition("PENDING", "UNKNOWN")).toBe(
      false,
    );

    for (const terminal of ["SUCCEEDED", "FAILED", "UNKNOWN"] as const) {
      for (const to of [
        "PENDING",
        "IN_FLIGHT",
        "SUCCEEDED",
        "FAILED",
        "UNKNOWN",
      ] as readonly ExecutionOperationStatus[]) {
        expect(isLegalExecutionOperationTransition(terminal, to)).toBe(false);
      }
    }
  });

  it("uses the next execution row version as event sequence", () => {
    expect(nextExecutionTransitionSequence(0)).toBe(1);
    expect(nextExecutionTransitionSequence(41)).toBe(42);
    expect(() => nextExecutionTransitionSequence(-1)).toThrow();
    expect(() =>
      nextExecutionTransitionSequence(Number.MAX_SAFE_INTEGER),
    ).toThrow();
  });
});

describe("ready execution-step selection", () => {
  const steps = [
    { stepId: "step-c", ordinal: 2, status: "PENDING" as const },
    { stepId: "step-b", ordinal: 1, status: "PENDING" as const },
    { stepId: "step-a", ordinal: 0, status: "PENDING" as const },
  ];

  it("returns dependency-free steps in ordinal then ID order", () => {
    expect(selectReadyExecutionSteps(steps, []).map((step) => step.stepId)).toEqual([
      "step-a",
      "step-b",
      "step-c",
    ]);
  });

  it.each(["PENDING", "RUNNING", "FAILED", "BLOCKED", "CANCELLED"] as const)(
    "does not ready a dependent step while its dependency is %s",
    (dependencyStatus) => {
      const result = selectReadyExecutionSteps(
        [
          { stepId: "parent", ordinal: 0, status: dependencyStatus },
          { stepId: "child", ordinal: 1, status: "PENDING" },
        ],
        [{ stepId: "child", dependsOnStepId: "parent" }],
      );
      expect(result.map((step) => step.stepId)).not.toContain("child");
    },
  );

  it("readies a dependent step only when every dependency succeeded", () => {
    const result = selectReadyExecutionSteps(
      [
        { stepId: "parent-a", ordinal: 0, status: "SUCCEEDED" },
        { stepId: "parent-b", ordinal: 1, status: "SUCCEEDED" },
        { stepId: "child", ordinal: 2, status: "PENDING" },
      ],
      [
        { stepId: "child", dependsOnStepId: "parent-a" },
        { stepId: "child", dependsOnStepId: "parent-b" },
      ],
    );
    expect(result.map((step) => step.stepId)).toEqual(["child"]);
  });
});
