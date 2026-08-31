import type { Cue } from "../../../domain/cue";
import {
  type PersistedCognitiveSession,
  persistedCognitiveSessionSchema,
} from "../../contracts/cognitive-session";
import {
  type PersistedCueIngress,
  persistedCueIngressSchema,
} from "../../contracts/cue-ingress";
import {
  type PersistedExecutionOperation,
  persistedExecutionOperationSchema,
} from "../../contracts/execution-operation";
import {
  type PersistedExecutionOperationAttempt,
  persistedExecutionOperationAttemptSchema,
} from "../../contracts/execution-operation-attempt";
import {
  type PersistedExecutionStepState,
  persistedExecutionStepStateSchema,
} from "../../contracts/execution-step-state";
import {
  type StoredExecutionSafety,
  storedExecutionSafetySchema,
} from "../../contracts/execution-safety";
import {
  type PersistedExecution,
  persistedExecutionSchema,
} from "../../contracts/execution";
import {
  type PersistedEvidence,
  persistedEvidenceSchema,
} from "../../contracts/persisted-evidence";
import {
  type PersistedCandidateAction,
  persistedCandidateActionSchema,
} from "../../contracts/persisted-candidate-action";
import {
  type PersistedGroundingResult,
  persistedGroundingResultSchema,
} from "../../contracts/persisted-grounding-result";
import {
  type PersistedPolicyDecision,
  persistedPolicyDecisionSchema,
} from "../../contracts/persisted-policy-decision";
import {
  type PersistedActionPlan,
  persistedActionPlanSchema,
} from "../../contracts/persisted-action-plan";
import {
  type PersistedObservation,
  persistedObservationSchema,
} from "../../contracts/persisted-observation";
import {
  type PersistedResultVerification,
  persistedResultVerificationSchema,
} from "../../contracts/result-verification";
import {
  type PersistedFailureAudit,
  persistedFailureAuditSchema,
} from "../../contracts/failure-audit";
import {
  type PersistedRewardEvent,
  persistedRewardEventSchema,
} from "../../contracts/reward-event";
import {
  type PersistedVerifiedMemory,
  persistedVerifiedMemorySchema,
} from "../../contracts/verified-memory";
import { PersistenceError } from "../errors/persistence-errors";

function normalizeDateString(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
  }
  return value;
}

export function decodeCueRow(row: unknown): PersistedCueIngress {
  if (typeof row !== "object" || row === null) {
    throw PersistenceError.invalidPersistedState(
      "Cue database row must be an object.",
      { row },
    );
  }

  const raw = row as Record<string, unknown>;
  const candidate = {
    cueId: raw.cueId ?? raw.cue_id,
    source: raw.source,
    externalEventId: raw.externalEventId ?? raw.external_event_id,
    type: raw.type ?? raw.cueType ?? raw.cue_type,
    occurredAt: normalizeDateString(raw.occurredAt ?? raw.occurred_at),
    receivedAt: normalizeDateString(raw.receivedAt ?? raw.received_at),
    payload: raw.payload,
  };

  const parsed = persistedCueIngressSchema.safeParse(candidate);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      "Failed to decode persisted cue ingress record.",
      { issues: parsed.error.issues, row },
    );
  }

  return parsed.data;
}

export function decodeCognitiveSessionRow(
  row: unknown,
): PersistedCognitiveSession {
  if (typeof row !== "object" || row === null) {
    throw PersistenceError.invalidPersistedState(
      "Cognitive session database row must be an object.",
      { row },
    );
  }

  const raw = row as Record<string, unknown>;
  const candidate = {
    sessionId: raw.sessionId ?? raw.session_id,
    cueId: raw.cueId ?? raw.cue_id,
    currentCandidateId:
      raw.currentCandidateId ?? raw.current_candidate_id ?? null,
    currentPlanId: raw.currentPlanId ?? raw.current_plan_id ?? null,
    currentExecutionId:
      raw.currentExecutionId ?? raw.current_execution_id ?? null,
    phase: raw.phase,
    failureCount: Number(raw.failureCount ?? raw.failure_count),
    retryCount: Number(raw.retryCount ?? raw.retry_count),
    maxRetries: Number(raw.maxRetries ?? raw.max_retries),
    cooldownUntil: normalizeDateString(
      raw.cooldownUntil ?? raw.cooldown_until ?? null,
    ),
    rowVersion: Number(raw.rowVersion ?? raw.row_version),
    createdAt: normalizeDateString(raw.createdAt ?? raw.created_at),
    updatedAt: normalizeDateString(raw.updatedAt ?? raw.updated_at),
  };

  const parsed = persistedCognitiveSessionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      "Failed to decode persisted cognitive session record.",
      { issues: parsed.error.issues, row },
    );
  }

  return parsed.data;
}

export function decodeExecutionSafetyRow(row: unknown): StoredExecutionSafety {
  if (typeof row !== "object" || row === null) {
    throw PersistenceError.invalidPersistedState(
      "Execution safety database row must be an object.",
      { row },
    );
  }

  const raw = row as Record<string, unknown>;
  const status = raw.status ?? raw.durableStatus ?? raw.durable_status;

  const candidate = {
    sessionId: raw.sessionId ?? raw.session_id,
    generation: Number(raw.generation),
    status,
    failure: raw.failure ?? raw.failureCode ?? raw.failure_code ?? null,
    reason: raw.reason,
    blockedAt: normalizeDateString(raw.blockedAt ?? raw.blocked_at ?? null),
    evaluatedCandidateId:
      raw.evaluatedCandidateId ?? raw.evaluated_candidate_id ?? null,
    groundingResultId: raw.groundingResultId ?? raw.grounding_result_id ?? null,
    policyDecisionId: raw.policyDecisionId ?? raw.policy_decision_id ?? null,
    updatedAt: normalizeDateString(raw.updatedAt ?? raw.updated_at),
  };

  const parsed = storedExecutionSafetySchema.safeParse(candidate);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      "Failed to decode stored execution safety record.",
      { issues: parsed.error.issues, row },
    );
  }

  return parsed.data;
}

export function decodeExecutionRow(row: unknown): PersistedExecution {
  if (typeof row !== "object" || row === null) {
    throw PersistenceError.invalidPersistedState(
      "Execution database row must be an object.",
      { row },
    );
  }

  const raw = row as Record<string, unknown>;
  const rawSafetyGen =
    raw.safetyGenerationAtStart ?? raw.safety_generation_at_start;

  const candidate = {
    executionId: raw.executionId ?? raw.execution_id,
    sessionId: raw.sessionId ?? raw.session_id,
    planId: raw.planId ?? raw.plan_id,
    status: raw.status,
    currentStepId: raw.currentStepId ?? raw.current_step_id ?? null,
    startedAt: normalizeDateString(raw.startedAt ?? raw.started_at ?? null),
    completedAt: normalizeDateString(
      raw.completedAt ?? raw.completed_at ?? null,
    ),
    error: raw.error ?? null,
    rowVersion: Number(raw.rowVersion ?? raw.row_version),
    safetyGenerationAtStart:
      rawSafetyGen !== null && rawSafetyGen !== undefined
        ? Number(rawSafetyGen)
        : null,
    createdAt: normalizeDateString(raw.createdAt ?? raw.created_at),
    updatedAt: normalizeDateString(raw.updatedAt ?? raw.updated_at),
  };

  const parsed = persistedExecutionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      "Failed to decode persisted execution record.",
      { issues: parsed.error.issues, row },
    );
  }

  return parsed.data;
}

export function decodeExecutionStepStateRow(
  row: unknown,
): PersistedExecutionStepState {
  if (typeof row !== "object" || row === null) {
    throw PersistenceError.invalidPersistedState(
      "Execution step-state database row must be an object.",
      { row },
    );
  }

  const raw = row as Record<string, unknown>;
  const candidate = {
    executionId: raw.executionId ?? raw.execution_id,
    planId: raw.planId ?? raw.plan_id,
    stepId: raw.stepId ?? raw.step_id,
    status: raw.status,
    operationGeneration: Number(
      raw.operationGeneration ?? raw.operation_generation,
    ),
    rowVersion: Number(raw.rowVersion ?? raw.row_version),
    startedAt: normalizeDateString(raw.startedAt ?? raw.started_at ?? null),
    completedAt: normalizeDateString(
      raw.completedAt ?? raw.completed_at ?? null,
    ),
    error: raw.error ?? null,
    updatedAt: normalizeDateString(raw.updatedAt ?? raw.updated_at),
  };

  const parsed = persistedExecutionStepStateSchema.safeParse(candidate);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      "Failed to decode persisted execution step-state record.",
      { issues: parsed.error.issues, row },
    );
  }

  return parsed.data;
}

export function decodeExecutionOperationRow(
  row: unknown,
): PersistedExecutionOperation {
  if (typeof row !== "object" || row === null) {
    throw PersistenceError.invalidPersistedState(
      "Execution operation database row must be an object.",
      { row },
    );
  }

  const raw = row as Record<string, unknown>;
  const candidate = {
    operationId: raw.operationId ?? raw.operation_id,
    executionId: raw.executionId ?? raw.execution_id,
    stepId: raw.stepId ?? raw.step_id,
    operationGeneration: Number(
      raw.operationGeneration ?? raw.operation_generation,
    ),
    operationKind: raw.operationKind ?? raw.operation_kind,
    idempotencyKey:
      raw.idempotencyKey ??
      raw.operationIdempotencyKey ??
      raw.operation_idempotency_key,
    requestFingerprint: raw.requestFingerprint ?? raw.request_fingerprint,
    status: raw.status,
    attemptCount: Number(raw.attemptCount ?? raw.attempt_count ?? 0),
    providerScope: raw.providerScope ?? raw.provider_scope ?? null,
    providerIdempotencyKey:
      raw.providerIdempotencyKey ?? raw.provider_idempotency_key ?? null,
    providerOperationId:
      raw.providerOperationId ?? raw.provider_operation_id ?? null,
    uncertaintyReason: raw.uncertaintyReason ?? raw.uncertainty_reason ?? null,
    reconciliationStatus:
      raw.reconciliationStatus ?? raw.reconciliation_status ?? "NOT_REQUIRED",
    reconciliationOutcome:
      raw.reconciliationOutcome ?? raw.reconciliation_outcome ?? null,
    rowVersion: Number(raw.rowVersion ?? raw.row_version ?? 0),
    createdAt: normalizeDateString(raw.createdAt ?? raw.created_at),
    updatedAt: normalizeDateString(raw.updatedAt ?? raw.updated_at),
  };

  const parsed = persistedExecutionOperationSchema.safeParse(candidate);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      `Failed to decode persisted execution operation record: ${JSON.stringify(parsed.error.issues)}`,
      { issues: parsed.error.issues, row },
    );
  }

  return parsed.data;
}

export function decodeExecutionOperationAttemptRow(
  row: unknown,
): PersistedExecutionOperationAttempt {
  if (typeof row !== "object" || row === null) {
    throw PersistenceError.invalidPersistedState(
      "Execution operation-attempt database row must be an object.",
      { row },
    );
  }

  const raw = row as Record<string, unknown>;
  const candidate = {
    attemptId: raw.attemptId ?? raw.attempt_id,
    operationId: raw.operationId ?? raw.operation_id,
    attemptNumber: Number(raw.attemptNumber ?? raw.attempt_number),
    status: raw.status,
    workerId: raw.workerId ?? raw.worker_id ?? null,
    startedAt: normalizeDateString(raw.startedAt ?? raw.started_at),
    finishedAt: normalizeDateString(raw.finishedAt ?? raw.finished_at ?? null),
    errorSummary: raw.errorSummary ?? raw.error_summary ?? null,
    providerMetadata:
      raw.providerMetadata ?? raw.provider_metadata ?? null,
  };

  const parsed = persistedExecutionOperationAttemptSchema.safeParse(candidate);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      "Failed to decode persisted execution operation-attempt record.",
      { issues: parsed.error.issues, row },
    );
  }

  return parsed.data;
}

export function decodeEvidenceRow(row: unknown): PersistedEvidence {
  if (typeof row !== "object" || row === null) {
    throw PersistenceError.invalidPersistedState(
      "Evidence database row must be an object.",
      { row },
    );
  }

  const raw = row as Record<string, unknown>;
  const candidate = {
    evidenceId: raw.evidenceId ?? raw.evidence_id,
    source: raw.source,
    sourceId: raw.sourceId ?? raw.source_id,
    claim: raw.claim,
    observedAt: normalizeDateString(raw.observedAt ?? raw.observed_at),
    createdAt: normalizeDateString(raw.createdAt ?? raw.created_at),
    providerMetadata: raw.providerMetadata ?? raw.provider_metadata ?? null,
  };

  const parsed = persistedEvidenceSchema.safeParse(candidate);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      `Failed to decode persisted evidence record: ${JSON.stringify(parsed.error.issues)}`,
      { issues: parsed.error.issues, row },
    );
  }

  return parsed.data;
}

export function decodeCandidateActionRow(
  row: unknown,
  evidenceIds: readonly string[] = [],
): PersistedCandidateAction {
  if (typeof row !== "object" || row === null) {
    throw PersistenceError.invalidPersistedState(
      "Candidate action database row must be an object.",
      { row },
    );
  }

  const raw = row as Record<string, unknown>;
  const candidate = {
    candidateId: raw.candidateId ?? raw.candidate_id,
    sessionId: raw.sessionId ?? raw.session_id,
    cueId: raw.cueId ?? raw.cue_id,
    goal: raw.goal,
    action: raw.action,
    confidence: Number(raw.confidence),
    expectedUtility: Number(raw.expectedUtility ?? raw.expected_utility),
    estimatedRisk: Number(raw.estimatedRisk ?? raw.estimated_risk),
    estimatedCost: Number(raw.estimatedCost ?? raw.estimated_cost),
    scoreValue: Number(raw.scoreValue ?? raw.score_value),
    recommendation: raw.recommendation,
    scoreFormulaVersion: raw.scoreFormulaVersion ?? raw.score_formula_version,
    evidenceIds: raw.evidenceIds ?? evidenceIds,
    createdAt: normalizeDateString(raw.createdAt ?? raw.created_at),
  };

  const parsed = persistedCandidateActionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      `Failed to decode persisted candidate action record: ${JSON.stringify(parsed.error.issues)}`,
      { issues: parsed.error.issues, row },
    );
  }

  return parsed.data;
}

export function decodeGroundingResultRow(
  row: unknown,
  evidenceIds: readonly string[] = [],
): PersistedGroundingResult {
  if (typeof row !== "object" || row === null) {
    throw PersistenceError.invalidPersistedState(
      "Grounding result database row must be an object.",
      { row },
    );
  }

  const raw = row as Record<string, unknown>;
  const candidate = {
    groundingResultId: raw.groundingResultId ?? raw.grounding_result_id,
    candidateId: raw.candidateId ?? raw.candidate_id,
    evaluationKey: raw.evaluationKey ?? raw.evaluation_key,
    status: raw.status,
    confidence: Number(raw.confidence),
    reason: raw.reason,
    evaluatorVersion: raw.evaluatorVersion ?? raw.evaluator_version,
    evidenceIds: raw.evidenceIds ?? evidenceIds,
    evaluatedAt: normalizeDateString(raw.evaluatedAt ?? raw.evaluated_at),
  };

  const parsed = persistedGroundingResultSchema.safeParse(candidate);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      `Failed to decode persisted grounding result record: ${JSON.stringify(parsed.error.issues)}`,
      { issues: parsed.error.issues, row },
    );
  }

  return parsed.data;
}

export function decodePolicyDecisionRow(
  row: unknown,
  policyIds: readonly string[] = [],
): PersistedPolicyDecision {
  if (typeof row !== "object" || row === null) {
    throw PersistenceError.invalidPersistedState(
      "Policy decision database row must be an object.",
      { row },
    );
  }

  const raw = row as Record<string, unknown>;
  const candidate = {
    policyDecisionId: raw.policyDecisionId ?? raw.policy_decision_id,
    candidateId: raw.candidateId ?? raw.candidate_id,
    groundingResultId: raw.groundingResultId ?? raw.grounding_result_id,
    evaluationKey: raw.evaluationKey ?? raw.evaluation_key,
    outcome: raw.outcome,
    reason: raw.reason,
    policyEngineVersion: raw.policyEngineVersion ?? raw.policy_engine_version,
    policyIds: raw.policyIds ?? policyIds,
    evaluatedAt: normalizeDateString(raw.evaluatedAt ?? raw.evaluated_at),
  };

  const parsed = persistedPolicyDecisionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      `Failed to decode persisted policy decision record: ${JSON.stringify(parsed.error.issues)}`,
      { issues: parsed.error.issues, row },
    );
  }

  return parsed.data;
}

export function decodeActionPlanRow(
  planRow: unknown,
  steps: readonly { stepId: string; ordinal: number; description: string }[],
  dependencies: readonly { stepId: string; dependsOnStepId: string }[] = [],
): PersistedActionPlan {
  if (typeof planRow !== "object" || planRow === null) {
    throw PersistenceError.invalidPersistedState(
      "Action plan database row must be an object.",
      { planRow },
    );
  }

  const raw = planRow as Record<string, unknown>;
  const candidate = {
    planId: raw.planId ?? raw.plan_id,
    candidateId: raw.candidateId ?? raw.candidate_id,
    planGeneration: Number(raw.planGeneration ?? raw.plan_generation),
    steps: steps.map((s) => ({
      stepId: s.stepId,
      ordinal: Number(s.ordinal),
      description: s.description,
    })),
    dependencies: dependencies.map((d) => ({
      stepId: d.stepId,
      dependsOnStepId: d.dependsOnStepId,
    })),
    createdAt: normalizeDateString(raw.createdAt ?? raw.created_at),
  };

  const parsed = persistedActionPlanSchema.safeParse(candidate);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      `Failed to decode persisted action plan record: ${JSON.stringify(parsed.error.issues)}`,
      { issues: parsed.error.issues, planRow },
    );
  }

  return parsed.data;
}

export function decodeObservationRow(row: unknown): PersistedObservation {
  if (typeof row !== "object" || row === null) {
    throw PersistenceError.invalidPersistedState(
      "Observation database row must be an object.",
      { row },
    );
  }

  const raw = row as Record<string, unknown>;
  const candidate = {
    observationId: raw.observationId ?? raw.observation_id,
    executionId: raw.executionId ?? raw.execution_id,
    stepId: raw.stepId ?? raw.step_id ?? null,
    source: raw.source,
    sourceEventId: raw.sourceEventId ?? raw.source_event_id ?? null,
    summary: raw.summary,
    data: raw.data,
    observedAt: normalizeDateString(raw.observedAt ?? raw.observed_at),
    payloadExpiresAt: normalizeDateString(
      raw.payloadExpiresAt ?? raw.payload_expires_at ?? null,
    ),
  };

  const parsed = persistedObservationSchema.safeParse(candidate);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      `Failed to decode persisted observation record: ${JSON.stringify(parsed.error.issues)}`,
      { issues: parsed.error.issues, row },
    );
  }

  return parsed.data;
}

export function decodeResultVerificationRow(
  row: unknown,
): PersistedResultVerification {
  if (typeof row !== "object" || row === null) {
    throw PersistenceError.invalidPersistedState(
      "Result verification database row must be an object.",
      { row },
    );
  }

  const raw = row as Record<string, unknown>;
  const candidate = {
    verificationId: raw.verificationId ?? raw.verification_id,
    executionId: raw.executionId ?? raw.execution_id,
    verificationGeneration: Number(
      raw.verificationGeneration ?? raw.verification_generation,
    ),
    observationSetDigest:
      raw.observationSetDigest ?? raw.observation_set_digest,
    verifierVersion: raw.verifierVersion ?? raw.verifier_version,
    status: raw.status,
    confidence: Number(raw.confidence),
    reason: raw.reason,
    verifiedAt: normalizeDateString(raw.verifiedAt ?? raw.verified_at),
  };

  const parsed = persistedResultVerificationSchema.safeParse(candidate);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      `Failed to decode persisted result verification record: ${JSON.stringify(parsed.error.issues)}`,
      { issues: parsed.error.issues, row },
    );
  }

  return parsed.data;
}

export function decodeFailureAuditRow(
  row: unknown,
  evidenceIds: readonly string[] = [],
): PersistedFailureAudit {
  if (typeof row !== "object" || row === null) {
    throw PersistenceError.invalidPersistedState(
      "Failure audit database row must be an object.",
      { row },
    );
  }

  const raw = row as Record<string, unknown>;
  const candidate = {
    auditEventId: raw.auditEventId ?? raw.audit_event_id,
    sessionId: raw.sessionId ?? raw.session_id,
    candidateId: raw.candidateId ?? raw.candidate_id ?? null,
    planId: raw.planId ?? raw.plan_id ?? null,
    executionId: raw.executionId ?? raw.execution_id ?? null,
    stepId: raw.stepId ?? raw.step_id ?? null,
    failure: raw.failure ?? raw.failureCode ?? raw.failure_code,
    recoveryAction: raw.recoveryAction ?? raw.recovery_action,
    phase: raw.phase ?? raw.originalPhase ?? raw.original_phase,
    failureCount: Number(raw.failureCount ?? raw.failure_count),
    retryCount: Number(raw.retryCount ?? raw.retry_count),
    fromSafetyGeneration: Number(
      raw.fromSafetyGeneration ?? raw.from_safety_generation,
    ),
    revokedSafetyGeneration: Number(
      raw.revokedSafetyGeneration ?? raw.revoked_safety_generation,
    ),
    reason: raw.reason,
    evidenceIds: raw.evidenceIds ?? evidenceIds,
    logicalFailureKey: raw.logicalFailureKey ?? raw.logical_failure_key,
    createdAt: normalizeDateString(raw.createdAt ?? raw.created_at),
  };

  const parsed = persistedFailureAuditSchema.safeParse(candidate);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      `Failed to decode persisted failure audit record: ${JSON.stringify(parsed.error.issues)}`,
      { issues: parsed.error.issues, row },
    );
  }

  return parsed.data;
}

export function decodeRewardEventRow(row: unknown): PersistedRewardEvent {
  if (typeof row !== "object" || row === null) {
    throw PersistenceError.invalidPersistedState(
      "Reward event database row must be an object.",
      { row },
    );
  }

  const raw = row as Record<string, unknown>;
  const candidate = {
    rewardEventId: raw.rewardEventId ?? raw.reward_event_id,
    executionId: raw.executionId ?? raw.execution_id,
    verificationId: raw.verificationId ?? raw.verification_id,
    rewardRuleId: raw.rewardRuleId ?? raw.reward_rule_id,
    rewardIdempotencyKey:
      raw.rewardIdempotencyKey ?? raw.reward_idempotency_key,
    signal: raw.signal,
    value: Number(raw.value),
    reason: raw.reason,
    createdAt: normalizeDateString(raw.createdAt ?? raw.created_at),
  };

  const parsed = persistedRewardEventSchema.safeParse(candidate);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      `Failed to decode persisted reward event record: ${JSON.stringify(parsed.error.issues)}`,
      { issues: parsed.error.issues, row },
    );
  }

  return parsed.data;
}

export function decodeVerifiedMemoryRow(
  row: unknown,
  sourceIds: readonly string[] = [],
): PersistedVerifiedMemory {
  if (typeof row !== "object" || row === null) {
    throw PersistenceError.invalidPersistedState(
      "Verified memory database row must be an object.",
      { row },
    );
  }

  const raw = row as Record<string, unknown>;
  const candidate = {
    memoryId: raw.memoryId ?? raw.memory_id,
    kind: raw.kind,
    key: raw.key ?? raw.memoryKey ?? raw.memory_key,
    version: Number(raw.version ?? raw.memoryVersion ?? raw.memory_version),
    content: raw.content,
    sourceIds: raw.sourceIds ?? sourceIds,
    confidence: Number(raw.confidence),
    admissionRuleVersion:
      raw.admissionRuleVersion ?? raw.admission_rule_version,
    supersedesMemoryId:
      raw.supersedesMemoryId ?? raw.supersedes_memory_id ?? null,
    verificationId:
      raw.verificationId ?? raw.verification_id ?? null,
    verifiedAt: normalizeDateString(raw.verifiedAt ?? raw.verified_at),
    createdAt: normalizeDateString(raw.createdAt ?? raw.created_at),
  };

  const parsed = persistedVerifiedMemorySchema.safeParse(candidate);
  if (!parsed.success) {
    throw PersistenceError.invalidPersistedState(
      `Failed to decode persisted verified memory record: ${JSON.stringify(parsed.error.issues)}`,
      { issues: parsed.error.issues, row },
    );
  }

  return parsed.data;
}

export interface PersistedIdempotencyRecord {
  readonly scope: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly status: "IN_PROGRESS" | "COMPLETED" | "FAILED" | "UNKNOWN";
  readonly resultResourceType: string | null;
  readonly resultResourceId: string | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
}

export function decodeIdempotencyRecordRow(
  row: unknown,
): PersistedIdempotencyRecord {
  if (typeof row !== "object" || row === null) {
    throw PersistenceError.invalidPersistedState(
      "Idempotency database row must be an object.",
      { row },
    );
  }

  const raw = row as Record<string, unknown>;
  return {
    scope: String(raw.scope),
    idempotencyKey: String(raw.idempotencyKey ?? raw.idempotency_key),
    requestHash: String(raw.requestHash ?? raw.request_hash),
    status: raw.status as "IN_PROGRESS" | "COMPLETED" | "FAILED" | "UNKNOWN",
    resultResourceType: (raw.resultResourceType ??
      raw.result_resource_type ??
      null) as string | null,
    resultResourceId: (raw.resultResourceId ??
      raw.result_resource_id ??
      null) as string | null,
    errorCode: (raw.errorCode ?? raw.error_code ?? null) as string | null,
    createdAt: String(normalizeDateString(raw.createdAt ?? raw.created_at)),
    updatedAt: String(normalizeDateString(raw.updatedAt ?? raw.updated_at)),
    expiresAt:
      raw.expiresAt || raw.expires_at
        ? String(normalizeDateString(raw.expiresAt ?? raw.expires_at))
        : null,
  };
}

export function mapPersistedCueToDomainCue(
  persisted: PersistedCueIngress,
): Cue {
  return {
    id: persisted.cueId,
    type: persisted.type,
    source: persisted.source,
    occurredAt: persisted.occurredAt,
    payload: persisted.payload,
  };
}
