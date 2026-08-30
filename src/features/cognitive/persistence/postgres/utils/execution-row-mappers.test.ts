import { describe, expect, it } from "vitest";

import {
  decodeExecutionOperationAttemptRow,
  decodeExecutionStepStateRow,
} from "./row-mappers";

describe("execution lifecycle row mappers", () => {
  it("normalizes and strictly decodes execution step rows", () => {
    expect(
      decodeExecutionStepStateRow({
        execution_id: "execution-1",
        plan_id: "plan-1",
        step_id: "step-1",
        status: "PENDING",
        operation_generation: 1,
        row_version: 0,
        started_at: null,
        completed_at: null,
        error: null,
        updated_at: new Date("2026-08-31T01:00:00.000Z"),
      }),
    ).toMatchObject({
      executionId: "execution-1",
      stepId: "step-1",
      status: "PENDING",
    });
  });

  it("fails closed on malformed execution step rows", () => {
    expect(() =>
      decodeExecutionStepStateRow({
        execution_id: "execution-1",
        plan_id: "plan-1",
        step_id: "step-1",
        status: "PENDING",
        operation_generation: 0,
        row_version: 0,
        updated_at: "not-a-timestamp",
      }),
    ).toThrow("decode persisted execution step-state");
  });

  it("normalizes and strictly decodes operation attempts", () => {
    expect(
      decodeExecutionOperationAttemptRow({
        attempt_id: "attempt-1",
        operation_id: "operation-1",
        attempt_number: 1,
        status: "IN_FLIGHT",
        worker_id: null,
        started_at: "2026-08-31T01:00:00.000Z",
        finished_at: null,
        error_summary: null,
        provider_metadata: null,
      }),
    ).toMatchObject({ attemptId: "attempt-1", status: "IN_FLIGHT" });
  });

  it("fails closed on malformed terminal attempt rows", () => {
    expect(() =>
      decodeExecutionOperationAttemptRow({
        attempt_id: "attempt-1",
        operation_id: "operation-1",
        attempt_number: 1,
        status: "UNKNOWN",
        worker_id: null,
        started_at: "2026-08-31T01:00:00.000Z",
        finished_at: null,
        error_summary: null,
        provider_metadata: null,
      }),
    ).toThrow("decode persisted execution operation-attempt");
  });
});
