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
  type StoredExecutionSafety,
  storedExecutionSafetySchema,
} from "../../contracts/execution-safety";
import {
  type PersistedExecution,
  persistedExecutionSchema,
} from "../../contracts/execution";
import { PersistenceError } from "../errors/persistence-errors";

function normalizeDateString(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
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
      "Failed to decode persisted execution operation record.",
      { issues: parsed.error.issues, row },
    );
  }

  return parsed.data;
}
