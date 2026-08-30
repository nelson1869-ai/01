import { describe, expect, it } from "vitest";

import { PersistenceError } from "../errors/persistence-errors";
import {
  decodeCognitiveSessionRow,
  decodeCueRow,
  decodeExecutionOperationRow,
  decodeExecutionRow,
  decodeExecutionSafetyRow,
} from "./row-mappers";

describe("persistence row decoding and validation", () => {
  it("decodes a valid cognitive session row", () => {
    const raw = {
      session_id: "session-1",
      cue_id: "cue-1",
      current_candidate_id: null,
      current_plan_id: null,
      current_execution_id: null,
      phase: "CUE",
      failure_count: 0,
      retry_count: 0,
      max_retries: 2,
      cooldown_until: null,
      row_version: 0,
      created_at: "2026-08-30T00:00:00.000Z",
      updated_at: "2026-08-30T00:00:00.000Z",
    };

    const decoded = decodeCognitiveSessionRow(raw);
    expect(decoded.sessionId).toBe("session-1");
    expect(decoded.cueId).toBe("cue-1");
    expect(decoded.phase).toBe("CUE");
    expect(decoded.failureCount).toBe(0);
    expect(decoded.rowVersion).toBe(0);
  });

  it("throws INVALID_PERSISTED_STATE on malformed persisted session row", () => {
    const invalid = {
      session_id: "session-1",
      cue_id: "cue-1",
      phase: "UNKNOWN_PHASE",
      failure_count: -1,
      created_at: "invalid-date",
    };

    expect(() => decodeCognitiveSessionRow(invalid)).toThrow(PersistenceError);
    try {
      decodeCognitiveSessionRow(invalid);
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe("INVALID_PERSISTED_STATE");
    }
  });

  it("decodes valid execution safety row in UNAUTHORIZED or BLOCKED state", () => {
    const unauthorizedRaw = {
      session_id: "session-1",
      generation: 0,
      durable_status: "UNAUTHORIZED",
      failure_code: null,
      reason: "Initial safety state",
      blocked_at: null,
      evaluated_candidate_id: null,
      grounding_result_id: null,
      policy_decision_id: null,
      updated_at: "2026-08-30T00:00:00.000Z",
    };

    const decodedUnauthorized = decodeExecutionSafetyRow(unauthorizedRaw);
    expect(decodedUnauthorized.status).toBe("UNAUTHORIZED");
    expect(decodedUnauthorized.generation).toBe(0);

    const blockedRaw = {
      session_id: "session-1",
      generation: 2,
      durable_status: "BLOCKED",
      failure_code: "POLICY_VIOLATION",
      reason: "Policy rule violated",
      blocked_at: "2026-08-30T00:01:00.000Z",
      evaluated_candidate_id: "candidate-1",
      grounding_result_id: "grounding-1",
      policy_decision_id: "policy-1",
      updated_at: "2026-08-30T00:01:00.000Z",
    };

    const decodedBlocked = decodeExecutionSafetyRow(blockedRaw);
    expect(decodedBlocked.status).toBe("BLOCKED");
    expect(decodedBlocked.failure).toBe("POLICY_VIOLATION");
  });

  it("rejects stored safety row claiming ALLOWED with INVALID_PERSISTED_STATE", () => {
    const forbiddenAllowedRaw = {
      session_id: "session-1",
      generation: 1,
      durable_status: "ALLOWED",
      failure_code: null,
      reason: "Forged permission",
      blocked_at: null,
      updated_at: "2026-08-30T00:00:00.000Z",
    };

    expect(() => decodeExecutionSafetyRow(forbiddenAllowedRaw)).toThrow(
      PersistenceError,
    );
    try {
      decodeExecutionSafetyRow(forbiddenAllowedRaw);
    } catch (error) {
      expect((error as PersistenceError).code).toBe("INVALID_PERSISTED_STATE");
    }
  });

  it("decodes UNKNOWN execution operation and keeps UNKNOWN state without mapping to FAILED", () => {
    const rawUnknownOp = {
      operation_id: "op-1",
      execution_id: "exec-1",
      step_id: "step-1",
      operation_generation: 1,
      operation_kind: "email.send",
      operation_idempotency_key: "key-1",
      request_fingerprint: "sha256:abc",
      status: "UNKNOWN",
      attempt_count: 1,
      uncertainty_reason: "Provider timed out before confirmation",
      reconciliation_status: "REQUIRED",
      row_version: 0,
      created_at: "2026-08-30T00:00:00.000Z",
      updated_at: "2026-08-30T00:00:00.000Z",
    };

    const decoded = decodeExecutionOperationRow(rawUnknownOp);
    expect(decoded.status).toBe("UNKNOWN");
    expect(decoded.uncertaintyReason).toBe(
      "Provider timed out before confirmation",
    );
    expect(decoded.status).not.toBe("FAILED");
  });

  it("decodes cue ingress row and execution row", () => {
    const rawCue = {
      cue_id: "cue-1",
      source: "github",
      external_event_id: "evt-123",
      cue_type: "github.issue.created",
      occurred_at: "2026-08-30T00:00:00.000Z",
      received_at: "2026-08-30T00:00:01.000Z",
      payload: { issue: 1 },
    };

    const decodedCue = decodeCueRow(rawCue);
    expect(decodedCue.cueId).toBe("cue-1");
    expect(decodedCue.source).toBe("github");

    const rawExec = {
      execution_id: "exec-1",
      session_id: "session-1",
      plan_id: "plan-1",
      status: "PENDING",
      current_step_id: null,
      started_at: null,
      completed_at: null,
      error: null,
      safety_generation_at_start: null,
      row_version: 0,
      created_at: "2026-08-30T00:00:00.000Z",
      updated_at: "2026-08-30T00:00:00.000Z",
    };

    const decodedExec = decodeExecutionRow(rawExec);
    expect(decodedExec.executionId).toBe("exec-1");
    expect(decodedExec.status).toBe("PENDING");
  });
});
