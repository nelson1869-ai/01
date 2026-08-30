import { describe, expect, it } from "vitest";

import type { PersistedCueIngress } from "../../contracts/cue-ingress";
import type { PersistedExecutionOperation } from "../../contracts/execution-operation";
import type { StoredExecutionSafety } from "../../contracts/execution-safety";
import type { SafetyTransitionCommand } from "../../contracts/transition-commands";
import { PersistenceError } from "../errors/persistence-errors";
import type { DatabaseExecutor } from "../transactions/transaction-executor";
import { CueRepository } from "./cue-repository";
import { ExecutionOperationRepository } from "./execution-operation-repository";
import { ExecutionRepository } from "./execution-repository";
import { SafetyRepository } from "./safety-repository";
import { SessionRepository } from "./session-repository";

type MockExecutor = DatabaseExecutor;

describe("repository and transaction unit invariants", () => {
  const sampleCue: PersistedCueIngress = {
    cueId: "cue-1",
    source: "github",
    externalEventId: "delivery-100",
    type: "github.issue.created",
    occurredAt: "2026-08-30T00:00:00.000Z",
    receivedAt: "2026-08-30T00:00:01.000Z",
    payload: { issueId: 42 },
  };

  const sampleOperation: PersistedExecutionOperation = {
    operationId: "op-1",
    executionId: "exec-1",
    stepId: "step-1",
    operationGeneration: 1,
    operationKind: "email.send",
    idempotencyKey: "op:exec-1:step-1:1",
    requestFingerprint: "sha256:fingerprint-1",
    status: "PENDING",
    attemptCount: 0,
    providerScope: null,
    providerIdempotencyKey: null,
    providerOperationId: null,
    uncertaintyReason: null,
    reconciliationStatus: "NOT_REQUIRED",
    reconciliationOutcome: null,
    rowVersion: 0,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };

  it("can import repository modules without requiring DATABASE_URL", async () => {
    const modules = await import("../index");
    expect(modules.cueRepository).toBeDefined();
    expect(modules.sessionRepository).toBeDefined();
    expect(modules.safetyRepository).toBeDefined();
    expect(modules.executionRepository).toBeDefined();
    expect(modules.executionOperationRepository).toBeDefined();
    expect(modules.createPostgresDatabase).toBeDefined();
  });

  describe("CueRepository unit logic", () => {
    it("handles cue replay when same external event has matching payload fingerprint", async () => {
      const cueRepo = new CueRepository();

      const mockExecutor = {
        insert: () => ({
          values: () => ({
            onConflictDoNothing: () => ({
              returning: () => [], // conflict occurred
            }),
          }),
        }),
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => [
                {
                  cue_id: "cue-1",
                  source: "github",
                  external_event_id: "delivery-100",
                  cue_type: "github.issue.created",
                  occurred_at: "2026-08-30T00:00:00.000Z",
                  received_at: "2026-08-30T00:00:01.000Z",
                  payload: { issueId: 42 },
                },
              ],
            }),
          }),
        }),
      } as unknown as MockExecutor;

      const result = await cueRepo.insertCue(mockExecutor, sampleCue);
      expect(result.isReplay).toBe(true);
      expect(result.cue.cueId).toBe("cue-1");
    });

    it("throws IDEMPOTENCY_CONFLICT when same external event has differing payload", async () => {
      const cueRepo = new CueRepository();

      const mockExecutor = {
        insert: () => ({
          values: () => ({
            onConflictDoNothing: () => ({
              returning: () => [], // conflict occurred
            }),
          }),
        }),
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => [
                {
                  cue_id: "cue-1",
                  source: "github",
                  external_event_id: "delivery-100",
                  cue_type: "github.issue.created",
                  occurred_at: "2026-08-30T00:00:00.000Z",
                  received_at: "2026-08-30T00:00:01.000Z",
                  payload: { issueId: 9999 },
                },
              ],
            }),
          }),
        }),
      } as unknown as MockExecutor;

      await expect(
        cueRepo.insertCue(mockExecutor, sampleCue),
      ).rejects.toThrowError(PersistenceError);

      try {
        await cueRepo.insertCue(mockExecutor, sampleCue);
      } catch (error) {
        expect((error as PersistenceError).code).toBe("IDEMPOTENCY_CONFLICT");
      }
    });
  });

  describe("SafetyRepository unit logic", () => {
    it("creates initial safety state as UNAUTHORIZED at generation 0", async () => {
      const safetyRepo = new SafetyRepository();
      const mockExecutor = {
        insert: () => ({
          values: (vals: Record<string, unknown>) => {
            expect(vals.generation).toBe(0);
            expect(vals.durableStatus).toBe("UNAUTHORIZED");
            return {
              returning: () => [
                {
                  session_id: "session-1",
                  generation: 0,
                  durable_status: "UNAUTHORIZED",
                  failure_code: null,
                  reason: "Initial safety state on cue ingestion.",
                  blocked_at: null,
                  evaluated_candidate_id: null,
                  grounding_result_id: null,
                  policy_decision_id: null,
                  updated_at: "2026-08-30T00:00:00.000Z",
                },
              ],
            };
          },
        }),
      } as unknown as MockExecutor;

      const initial = await safetyRepo.createInitialSafetyState(
        mockExecutor,
        "session-1",
        "2026-08-30T00:00:00.000Z",
      );

      expect(initial.status).toBe("UNAUTHORIZED");
      expect(initial.generation).toBe(0);
    });

    it("throws STALE_WRITE when conditional safety update affects 0 rows", async () => {
      const safetyRepo = new SafetyRepository();
      const mockExecutor = {
        update: () => ({
          set: () => ({
            where: () => ({
              returning: () => [],
            }),
          }),
        }),
      } as unknown as MockExecutor;

      const blockedState: StoredExecutionSafety = {
        sessionId: "session-1",
        generation: 2,
        status: "BLOCKED",
        failure: "HALLUCINATION_DETECTED",
        reason: "Grounding check failed",
        blockedAt: "2026-08-30T00:01:00.000Z",
        evaluatedCandidateId: "cand-1",
        groundingResultId: "ground-1",
        policyDecisionId: "policy-1",
        updatedAt: "2026-08-30T00:01:00.000Z",
      };

      const command: SafetyTransitionCommand = {
        sessionId: "session-1",
        expectedGeneration: 1,
        nextState: blockedState,
        commandIdempotencyKey: "safety:session-1:1:2",
      };

      await expect(
        safetyRepo.transitionSafety(mockExecutor, command),
      ).rejects.toThrow(PersistenceError);

      try {
        await safetyRepo.transitionSafety(mockExecutor, command);
      } catch (error) {
        expect((error as PersistenceError).code).toBe("STALE_WRITE");
      }
    });
  });

  describe("SessionRepository unit logic", () => {
    it("throws STALE_WRITE when session transition affects 0 rows", async () => {
      const sessionRepo = new SessionRepository();
      const mockExecutor = {
        update: () => ({
          set: () => ({
            where: () => ({
              returning: () => [],
            }),
          }),
        }),
      } as unknown as MockExecutor;

      await expect(
        sessionRepo.transitionSession(mockExecutor, {
          sessionId: "session-1",
          expectedRowVersion: 0,
          nextSessionState: {
            phase: "PERCEIVE",
            failureCount: 0,
            retryCount: 0,
            maxRetries: 2,
            cooldownUntil: null,
            updatedAt: "2026-08-30T00:00:01.000Z",
          },
        }),
      ).rejects.toThrow(PersistenceError);
    });
  });

  describe("ExecutionRepository unit logic", () => {
    it("rejects non-PENDING status when creating pending execution", async () => {
      const execRepo = new ExecutionRepository();
      const mockExecutor = {} as unknown as MockExecutor;

      await expect(
        execRepo.createPendingExecution(mockExecutor, {
          executionId: "exec-1",
          sessionId: "session-1",
          planId: "plan-1",
          status: "RUNNING",
          currentStepId: null,
          startedAt: "2026-08-30T00:00:00.000Z",
          completedAt: null,
          error: null,
          safetyGenerationAtStart: 1,
          rowVersion: 1,
          createdAt: "2026-08-30T00:00:00.000Z",
          updatedAt: "2026-08-30T00:00:00.000Z",
        }),
      ).rejects.toThrow(PersistenceError);
    });

    it("throws STATE_CONFLICT when authoritative safety generation is stale or revoked", async () => {
      const execRepo = new ExecutionRepository();

      const mockExecutor = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => [],
            }),
          }),
        }),
      } as unknown as MockExecutor;

      await expect(
        execRepo.startExecution(mockExecutor, {
          executionId: "exec-1",
          sessionId: "session-1",
          planId: "plan-1",
          expectedRowVersion: 0,
          expectedSafetyGeneration: 7,
          startedAt: "2026-08-30T00:01:00.000Z",
          commandIdempotencyKey: "start:exec-1:0:7",
          reason: "Starting execution",
        }),
      ).rejects.toThrow(PersistenceError);

      try {
        await execRepo.startExecution(mockExecutor, {
          executionId: "exec-1",
          sessionId: "session-1",
          planId: "plan-1",
          expectedRowVersion: 0,
          expectedSafetyGeneration: 7,
          startedAt: "2026-08-30T00:01:00.000Z",
          commandIdempotencyKey: "start:exec-1:0:7",
          reason: "Starting execution",
        });
      } catch (error) {
        expect((error as PersistenceError).code).toBe("STATE_CONFLICT");
      }
    });

    it("throws STALE_WRITE when execution row version is stale", async () => {
      const execRepo = new ExecutionRepository();

      const mockExecutor = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => [
                {
                  session_id: "session-1",
                  generation: 7,
                  durable_status: "UNAUTHORIZED",
                },
              ],
            }),
          }),
        }),
        update: () => ({
          set: () => ({
            where: () => ({
              returning: () => [],
            }),
          }),
        }),
      } as unknown as MockExecutor;

      await expect(
        execRepo.startExecution(mockExecutor, {
          executionId: "exec-1",
          sessionId: "session-1",
          planId: "plan-1",
          expectedRowVersion: 0,
          expectedSafetyGeneration: 7,
          startedAt: "2026-08-30T00:01:00.000Z",
          commandIdempotencyKey: "start:exec-1:0:7",
          reason: "Starting execution",
        }),
      ).rejects.toThrow(PersistenceError);

      try {
        await execRepo.startExecution(mockExecutor, {
          executionId: "exec-1",
          sessionId: "session-1",
          planId: "plan-1",
          expectedRowVersion: 0,
          expectedSafetyGeneration: 7,
          startedAt: "2026-08-30T00:01:00.000Z",
          commandIdempotencyKey: "start:exec-1:0:7",
          reason: "Starting execution",
        });
      } catch (error) {
        expect((error as PersistenceError).code).toBe("STALE_WRITE");
      }
    });
  });

  describe("ExecutionOperationRepository unit logic", () => {
    it("reuses existing operation on matching idempotency key and request fingerprint", async () => {
      const opRepo = new ExecutionOperationRepository();

      const mockExecutor = {
        insert: () => ({
          values: () => ({
            onConflictDoNothing: () => ({
              returning: () => [], // conflict occurred
            }),
          }),
        }),
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => [
                {
                  operation_id: "op-1",
                  execution_id: "exec-1",
                  step_id: "step-1",
                  operation_generation: 1,
                  operation_kind: "email.send",
                  operation_idempotency_key: "op:exec-1:step-1:1",
                  request_fingerprint: "sha256:fingerprint-1",
                  status: "PENDING",
                  attempt_count: 0,
                  provider_scope: null,
                  provider_idempotency_key: null,
                  provider_operation_id: null,
                  uncertainty_reason: null,
                  reconciliation_status: "NOT_REQUIRED",
                  reconciliation_outcome: null,
                  row_version: 0,
                  created_at: "2026-08-30T00:00:00.000Z",
                  updated_at: "2026-08-30T00:00:00.000Z",
                },
              ],
            }),
          }),
        }),
      } as unknown as MockExecutor;

      const result = await opRepo.reserveExecutionOperation(
        mockExecutor,
        sampleOperation,
      );
      expect(result.isReplay).toBe(true);
      expect(result.operation.operationId).toBe("op-1");
    });

    it("throws IDEMPOTENCY_CONFLICT on same idempotency key with differing request fingerprint", async () => {
      const opRepo = new ExecutionOperationRepository();

      const mockExecutor = {
        insert: () => ({
          values: () => ({
            onConflictDoNothing: () => ({
              returning: () => [], // conflict occurred
            }),
          }),
        }),
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => [
                {
                  operation_id: "op-1",
                  execution_id: "exec-1",
                  step_id: "step-1",
                  operation_generation: 1,
                  operation_kind: "email.send",
                  operation_idempotency_key: "op:exec-1:step-1:1",
                  request_fingerprint: "sha256:different-fingerprint",
                  status: "PENDING",
                  attempt_count: 0,
                  provider_scope: null,
                  provider_idempotency_key: null,
                  provider_operation_id: null,
                  uncertainty_reason: null,
                  reconciliation_status: "NOT_REQUIRED",
                  reconciliation_outcome: null,
                  row_version: 0,
                  created_at: "2026-08-30T00:00:00.000Z",
                  updated_at: "2026-08-30T00:00:00.000Z",
                },
              ],
            }),
          }),
        }),
      } as unknown as MockExecutor;

      await expect(
        opRepo.reserveExecutionOperation(mockExecutor, sampleOperation),
      ).rejects.toThrow(PersistenceError);

      try {
        await opRepo.reserveExecutionOperation(mockExecutor, sampleOperation);
      } catch (error) {
        expect((error as PersistenceError).code).toBe("IDEMPOTENCY_CONFLICT");
      }
    });
  });
});
