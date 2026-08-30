import { describe, expect, it } from "vitest";

import { PersistenceError } from "../errors/persistence-errors";
import {
  decodeActionPlanRow,
  decodeCandidateActionRow,
  decodeCognitiveSessionRow,
  decodeCueRow,
  decodeEvidenceRow,
  decodeExecutionOperationRow,
  decodeExecutionRow,
  decodeExecutionSafetyRow,
  decodeFailureAuditRow,
  decodeGroundingResultRow,
  decodeIdempotencyRecordRow,
  decodeObservationRow,
  decodePolicyDecisionRow,
  decodeResultVerificationRow,
  decodeRewardEventRow,
  decodeVerifiedMemoryRow,
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

  it("decodes evidence, candidate action, and grounding rows", () => {
    const evRaw = {
      evidence_id: "ev-1",
      source: "github",
      source_id: "issue-100",
      claim: "Issue 100 reported a regression",
      observed_at: "2026-08-30T00:00:00.000Z",
      created_at: "2026-08-30T00:00:01.000Z",
      provider_metadata: { repo: "org/app" },
    };

    const ev = decodeEvidenceRow(evRaw);
    expect(ev.evidenceId).toBe("ev-1");
    expect(ev.claim).toBe("Issue 100 reported a regression");

    const candRaw = {
      candidate_id: "cand-1",
      session_id: "session-1",
      cue_id: "cue-1",
      goal: "Resolve issue",
      action: "Patch bug",
      confidence: "0.9500",
      expected_utility: "0.9000",
      estimated_risk: "0.1000",
      estimated_cost: "0.0500",
      score_value: "0.8800",
      recommendation: "PROCEED",
      score_formula_version: "v1",
      created_at: "2026-08-30T00:01:00.000Z",
    };

    const cand = decodeCandidateActionRow(candRaw, ["ev-1"]);
    expect(cand.candidateId).toBe("cand-1");
    expect(cand.confidence).toBe(0.95);
    expect(cand.evidenceIds).toEqual(["ev-1"]);

    const groundRaw = {
      grounding_result_id: "ground-1",
      candidate_id: "cand-1",
      evaluation_key: "ground:1",
      status: "VERIFIED",
      confidence: "0.9800",
      reason: "Confirmed against repository history",
      evaluator_version: "v1",
      evaluated_at: "2026-08-30T00:02:00.000Z",
    };

    const ground = decodeGroundingResultRow(groundRaw, ["ev-1"]);
    expect(ground.groundingResultId).toBe("ground-1");
    expect(ground.confidence).toBe(0.98);
  });

  it("decodes policy decision, action plan, and observation rows", () => {
    const polRaw = {
      policy_decision_id: "policy-1",
      candidate_id: "cand-1",
      grounding_result_id: "ground-1",
      evaluation_key: "policy:1",
      outcome: "ALLOW",
      reason: "All safety rules satisfied",
      policy_engine_version: "v1",
      evaluated_at: "2026-08-30T00:03:00.000Z",
    };

    const pol = decodePolicyDecisionRow(polRaw, ["pol-check-1"]);
    expect(pol.policyDecisionId).toBe("policy-1");
    expect(pol.policyIds).toEqual(["pol-check-1"]);

    const planRaw = {
      plan_id: "plan-1",
      candidate_id: "cand-1",
      plan_generation: 1,
      created_at: "2026-08-30T00:04:00.000Z",
    };

    const plan = decodeActionPlanRow(
      planRaw,
      [
        { stepId: "s1", ordinal: 0, description: "Step 1" },
        { stepId: "s2", ordinal: 1, description: "Step 2" },
      ],
      [{ stepId: "s2", dependsOnStepId: "s1" }],
    );
    expect(plan.planId).toBe("plan-1");
    expect(plan.steps.length).toBe(2);

    const obsRaw = {
      observation_id: "obs-1",
      execution_id: "exec-1",
      step_id: "s1",
      source: "stdout",
      source_event_id: "line-1",
      summary: "Completed successfully",
      data: { code: 0 },
      observed_at: "2026-08-30T00:05:00.000Z",
      payload_expires_at: null,
    };

    const obs = decodeObservationRow(obsRaw);
    expect(obs.observationId).toBe("obs-1");
    expect(obs.data).toEqual({ code: 0 });
  });

  it("decodes verification, failure audit, reward, verified memory, and idempotency rows", () => {
    const verRaw = {
      verification_id: "ver-1",
      execution_id: "exec-1",
      verification_generation: 1,
      observation_set_digest: "sha256:obs",
      verifier_version: "v1",
      status: "VERIFIED",
      confidence: "0.9900",
      reason: "Output matched expectation",
      verified_at: "2026-08-30T00:06:00.000Z",
    };

    const ver = decodeResultVerificationRow(verRaw);
    expect(ver.verificationId).toBe("ver-1");

    const auditRaw = {
      audit_event_id: "audit-1",
      session_id: "session-1",
      candidate_id: "cand-1",
      plan_id: "plan-1",
      execution_id: "exec-1",
      step_id: null,
      failure_code: "EXECUTION_TIMEOUT",
      recovery_action: "RETRY_WITH_FRESH_CONTEXT",
      original_phase: "ACT",
      failure_count: 1,
      retry_count: 0,
      from_safety_generation: 0,
      revoked_safety_generation: 1,
      reason: "Operation timed out",
      logical_failure_key: "fail:1",
      created_at: "2026-08-30T00:07:00.000Z",
    };

    const audit = decodeFailureAuditRow(auditRaw, ["ev-1"]);
    expect(audit.auditEventId).toBe("audit-1");
    expect(audit.failure).toBe("EXECUTION_TIMEOUT");

    const rewRaw = {
      reward_event_id: "rew-1",
      execution_id: "exec-1",
      verification_id: "ver-1",
      reward_rule_id: "rule-1",
      reward_idempotency_key: "rew:key:1",
      signal: "SUCCESS",
      value: "10.0000",
      reason: "Successful verification",
      created_at: "2026-08-30T00:08:00.000Z",
    };

    const rew = decodeRewardEventRow(rewRaw);
    expect(rew.rewardEventId).toBe("rew-1");
    expect(rew.value).toBe(10);

    const memRaw = {
      memory_id: "mem-1",
      kind: "FACT",
      memory_key: "key-1",
      memory_version: 1,
      content: { answer: 42 },
      confidence: "0.9500",
      admission_rule_version: "v1",
      supersedes_memory_id: null,
      verified_at: "2026-08-30T00:09:00.000Z",
      created_at: "2026-08-30T00:09:01.000Z",
    };

    const mem = decodeVerifiedMemoryRow(memRaw, ["ev-1"]);
    expect(mem.memoryId).toBe("mem-1");
    expect(mem.version).toBe(1);

    const idempRaw = {
      scope: "failure-recovery",
      idempotency_key: "cmd-1",
      request_hash: "hash-1",
      status: "COMPLETED",
      result_resource_type: "failure_audit_events",
      result_resource_id: "audit-1",
      error_code: null,
      created_at: "2026-08-30T00:10:00.000Z",
      updated_at: "2026-08-30T00:10:01.000Z",
      expires_at: null,
    };

    const idemp = decodeIdempotencyRecordRow(idempRaw);
    expect(idemp.scope).toBe("failure-recovery");
    expect(idemp.status).toBe("COMPLETED");
  });
});
