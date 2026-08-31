import type {
  JSONObject,
  OperationAdapter,
} from "../adapters/adapter-contract";
import type { AllowedExecutionSafetyState } from "../domain/execution-safety";
import type { CognitivePhase } from "../domain/types";
import type { ResultVerifier } from "../domain/verifier-contract";
import type { PersistedCandidateAction } from "../persistence/contracts/persisted-candidate-action";
import type { PersistedCognitiveSession } from "../persistence/contracts/cognitive-session";
import type { PersistedCueIngress } from "../persistence/contracts/cue-ingress";
import type { PersistedEvidence } from "../persistence/contracts/persisted-evidence";
import type { PersistedGroundingResult } from "../persistence/contracts/persisted-grounding-result";
import type { PersistedActionPlan } from "../persistence/contracts/persisted-action-plan";
import type { PersistedPolicyDecision } from "../persistence/contracts/persisted-policy-decision";
import { getDefaultRewardForVerificationStatus } from "../persistence/contracts/reward-commands";
import { PersistenceError } from "../persistence/postgres/errors/persistence-errors";
import { candidateRepository } from "../persistence/postgres/repositories/candidate-repository";
import { cueRepository } from "../persistence/postgres/repositories/cue-repository";
import { evidenceRepository } from "../persistence/postgres/repositories/evidence-repository";
import { executionOperationRepository } from "../persistence/postgres/repositories/execution-operation-repository";
import { executionRepository } from "../persistence/postgres/repositories/execution-repository";
import { groundingRepository } from "../persistence/postgres/repositories/grounding-repository";
import { learningRepository } from "../persistence/postgres/repositories/learning-repository";
import { memoryRepository } from "../persistence/postgres/repositories/memory-repository";
import { observationRepository } from "../persistence/postgres/repositories/observation-repository";
import { perceptionSnapshotRepository } from "../persistence/postgres/repositories/perception-snapshot-repository";
import { planRepository } from "../persistence/postgres/repositories/plan-repository";
import { policyRepository } from "../persistence/postgres/repositories/policy-repository";
import { safetyRepository } from "../persistence/postgres/repositories/safety-repository";
import { sessionRepository } from "../persistence/postgres/repositories/session-repository";
import { executionStepRepository } from "../persistence/postgres/repositories/execution-step-repository";
import { verificationRepository } from "../persistence/postgres/repositories/verification-repository";
import { persistFailureRecovery } from "../persistence/postgres/transactions/persist-failure-recovery";
import { createCanonicalFingerprint } from "../persistence/postgres/utils/canonical-fingerprint";
import type { DatabaseClient } from "../persistence/postgres/transactions/transaction-executor";
import {
  parseGitHubTargetSpec,
  gitHubTargetSpecSchema,
  type GitHubTargetSpec,
} from "../domain/target-spec";
import { assertDataSecurity } from "../security/secret-safety";
import { orchestrateAuthorizationIssuance } from "./authorization-orchestrator";
import { rankCandidates } from "./candidate-ranking";
import type {
  CandidateGeneratorPort,
  GroundingEvaluatorPort,
  MemoryProposalStrategyPort,
  PerceptionPort,
  PlanBuilderPort,
  PolicyEvaluatorPort,
} from "./cognitive-ports";
import {
  assembleCognitiveContext,
  assertContextSecurity,
  type MemoryHeadRequest,
  type PerceptionResult,
} from "./context-assembler";
import { dispatchAuthorizedOperation } from "./dispatch-orchestrator";
import { prepareAuthorizedExecution } from "./execution-preparation-orchestrator";
import {
  reserveAuthorizedExecutionOperation,
  startAuthorizedExecution,
  startAuthorizedExecutionStep,
} from "./execution-progress-orchestrator";
import {
  completeExecutionStep,
  failExecutionStep,
  finalizeExecutionIfComplete,
  finalizeExecutionFailure,
} from "./execution-outcome-orchestrator";
import { admitVerifiedMemory } from "./memory-orchestrator";
import { recordObservation } from "./observation-orchestrator";
import {
  inspectRecoveryState,
  orchestrateRecoverySession,
} from "./recovery-orchestrator";
import { applyVerificationReward } from "./reward-orchestrator";
import { verifyExecutionResult } from "./verification-orchestrator";
import {
  DefaultOperationRequestBuilder,
  type OperationRequestBuilderPort,
} from "./operation-request-builder";

export type CognitiveCycleResult =
  | {
      readonly status: "COMPLETED";
      readonly sessionId: string;
      readonly executionId: string;
      readonly verificationId: string;
      readonly rewardEventId: string;
      readonly memoriesAdmitted: number;
    }
  | {
      readonly status: "NO_ACTION";
      readonly sessionId: string;
      readonly reason: string;
    }
  | {
      readonly status: "RECONCILIATION_REQUIRED";
      readonly sessionId: string;
      readonly executionId?: string;
      readonly operationId?: string;
      readonly reason: string;
    }
  | {
      readonly status: "HUMAN_REVIEW_REQUIRED";
      readonly sessionId: string;
      readonly reason: string;
      readonly details?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: "COOLDOWN";
      readonly sessionId: string;
      readonly cooldownUntil: string | null;
      readonly remainingMs: number;
    }
  | {
      readonly status: "BLOCKED";
      readonly sessionId: string;
      readonly reason: string;
    }
  | {
      readonly status: "FAILED";
      readonly sessionId: string;
      readonly executionId?: string;
      readonly reason: string;
    };

export interface AdvanceCycleOutcome {
  readonly isBoundary: boolean;
  readonly cycleResult?: CognitiveCycleResult;
  readonly nextSession: PersistedCognitiveSession;
  readonly runtimeAuthorization?: AllowedExecutionSafetyState;
}

export interface CognitiveCyclePorts {
  readonly perception: PerceptionPort;
  readonly candidateGenerator: CandidateGeneratorPort;
  readonly groundingEvaluator: GroundingEvaluatorPort;
  readonly policyEvaluator: PolicyEvaluatorPort;
  readonly planBuilder: PlanBuilderPort;
  readonly verifier: ResultVerifier;
  readonly adapter: OperationAdapter;
  readonly memoryProposalStrategy?: MemoryProposalStrategyPort;
  readonly requestBuilder?: OperationRequestBuilderPort;
}

export interface AdvanceCycleOptions {
  readonly skillKey: string;
  readonly memoryRequests?: readonly MemoryHeadRequest[];
  readonly now?: string;
  readonly runtimeAuthorization?: AllowedExecutionSafetyState;
}

export interface SingleTransitionResult {
  readonly isBoundary: boolean;
  readonly cycleResult?: CognitiveCycleResult;
  readonly nextSession: PersistedCognitiveSession;
  readonly runtimeAuthorization?: AllowedExecutionSafetyState;
}

async function getOrComputePerceptionSnapshot(
  db: DatabaseClient,
  session: PersistedCognitiveSession,
  cue: PersistedCueIngress,
  perceptionPort: PerceptionPort,
  now: string,
): Promise<{ perception: PerceptionResult; targetSpec: GitHubTargetSpec }> {
  const existing =
    await perceptionSnapshotRepository.findBySessionAndGeneration(
      db,
      session.sessionId,
      session.evaluationGeneration,
    );

  if (existing) {
    const targetSpec = existing.targetSpec
      ? gitHubTargetSpecSchema.parse(existing.targetSpec)
      : parseGitHubTargetSpec(
          (existing.structuredFacts?.action as string) ||
            ((cue.payload as Record<string, unknown>)
              ?.requestedAction as string) ||
            "github.repo.get",
          existing.summary,
          existing.structuredFacts,
        );
    return {
      perception: {
        summary: existing.summary,
        structuredFacts: existing.structuredFacts,
        perceivedAt: existing.perceivedAt,
      },
      targetSpec,
    };
  }

  // Compute fresh perception once per generation
  const rawPerception = await perceptionPort.perceive(cue);
  assertDataSecurity(rawPerception, "perception");

  const action =
    (rawPerception.structuredFacts?.action as string) ||
    ((cue.payload as Record<string, unknown>)?.requestedAction as string) ||
    "github.repo.get";

  const targetSpec = parseGitHubTargetSpec(
    action,
    rawPerception.summary,
    rawPerception.structuredFacts,
  );

  const snapshotId = `psnap:${session.sessionId}:gen${session.evaluationGeneration}`;
  const saved = await perceptionSnapshotRepository.saveSnapshot(db, {
    snapshotId,
    sessionId: session.sessionId,
    cueId: cue.cueId,
    evaluationGeneration: session.evaluationGeneration,
    summary: rawPerception.summary,
    structuredFacts: rawPerception.structuredFacts,
    targetSpec: targetSpec as unknown as Record<string, unknown>,
    perceivedAt: rawPerception.perceivedAt || now,
    createdAt: now,
  });

  return {
    perception: {
      summary: saved.summary,
      structuredFacts: saved.structuredFacts,
      perceivedAt: saved.perceivedAt,
    },
    targetSpec,
  };
}

/**
 * Advance cognitive cycle by exactly ONE durable phase transition.
 * Uses optimistic concurrency CAS (row_version) on all session state updates.
 */
export async function advanceCognitiveCycle(
  db: DatabaseClient,
  sessionId: string,
  ports: CognitiveCyclePorts,
  options: AdvanceCycleOptions,
  runtimeAuthorization?: AllowedExecutionSafetyState,
): Promise<SingleTransitionResult> {
  const now = options.now ?? new Date().toISOString();
  const effectiveAuth = runtimeAuthorization ?? options.runtimeAuthorization;

  // 1. Load authoritative session state
  const session = await sessionRepository.findSessionById(db, sessionId);
  if (!session) {
    throw PersistenceError.notFound(
      `Cognitive session "${sessionId}" was not found.`,
    );
  }

  // Check safety state: allow pure cognition phases even if safety is BLOCKED
  const safety = await safetyRepository.findSafetyStateBySessionId(
    db,
    sessionId,
  );
  const isPureCognitionPhase =
    session.phase === "CUE" ||
    session.phase === "PERCEIVE" ||
    session.phase === "BUILD_CONTEXT" ||
    session.phase === "RETRIEVE_MEMORY" ||
    session.phase === "GENERATE_CANDIDATES" ||
    session.phase === "SCORE" ||
    session.phase === "GROUND_VERIFY" ||
    session.phase === "POLICY_SAFETY" ||
    session.phase === "COOLDOWN" ||
    session.phase === "HUMAN_REVIEW";

  if (
    safety &&
    safety.status === "BLOCKED" &&
    !isPureCognitionPhase &&
    !effectiveAuth
  ) {
    return {
      isBoundary: true,
      cycleResult: {
        status: "BLOCKED",
        sessionId,
        reason: "Session safety status is permanently BLOCKED.",
      },
      nextSession: session,
    };
  }

  switch (session.phase) {
    case "IDLE": {
      if (!session.cueId) {
        return {
          isBoundary: true,
          cycleResult: {
            status: "NO_ACTION",
            sessionId,
            reason: "Session has no pending cue.",
          },
          nextSession: session,
        };
      }
      const updated = await transitionSessionPhase(db, session, "CUE", now);
      return { isBoundary: false, nextSession: updated };
    }

    case "CUE": {
      if (!session.cueId) {
        throw PersistenceError.invalidPersistedState(
          "Session in CUE phase is missing cueId.",
        );
      }
      const cue = await cueRepository.findCueById(db, session.cueId);
      if (!cue) {
        throw PersistenceError.notFound(
          `Cue "${session.cueId}" was not found for session "${sessionId}".`,
        );
      }
      const updated = await transitionSessionPhase(
        db,
        session,
        "PERCEIVE",
        now,
      );
      return { isBoundary: false, nextSession: updated };
    }

    case "PERCEIVE": {
      if (!session.cueId) {
        throw PersistenceError.invalidPersistedState(
          "Session in PERCEIVE phase is missing cueId.",
        );
      }
      const cue = await cueRepository.findCueById(db, session.cueId);
      if (!cue) {
        throw PersistenceError.notFound(
          `Cue "${session.cueId}" was not found for session "${sessionId}".`,
        );
      }

      // Persist or load authoritative perception snapshot for current generation
      const { perception } = await getOrComputePerceptionSnapshot(
        db,
        session,
        cue,
        ports.perception,
        now,
      );

      const updated = await transitionSessionPhase(
        db,
        session,
        "BUILD_CONTEXT",
        perception.perceivedAt || now,
      );
      return { isBoundary: false, nextSession: updated };
    }

    case "BUILD_CONTEXT": {
      const cue = await getRequiredCue(db, session);
      const { perception } = await getOrComputePerceptionSnapshot(
        db,
        session,
        cue,
        ports.perception,
        now,
      );

      const updated = await transitionSessionPhase(
        db,
        session,
        "RETRIEVE_MEMORY",
        perception.perceivedAt || now,
      );
      return { isBoundary: false, nextSession: updated };
    }

    case "RETRIEVE_MEMORY": {
      const cue = await getRequiredCue(db, session);
      const { perception, targetSpec } = await getOrComputePerceptionSnapshot(
        db,
        session,
        cue,
        ports.perception,
        now,
      );

      const context = await assembleCognitiveContext(db, {
        session,
        cue,
        perception,
        targetSpec,
        skillKey: options.skillKey,
        memoryRequests: options.memoryRequests,
      });
      assertContextSecurity(context);

      const updated = await transitionSessionPhase(
        db,
        session,
        "GENERATE_CANDIDATES",
        now,
      );
      return { isBoundary: false, nextSession: updated };
    }

    case "GENERATE_CANDIDATES": {
      const cue = await getRequiredCue(db, session);

      // Replay / restart optimization: Reuse candidates for this specific evaluation generation
      const existingCandidates =
        await candidateRepository.findCandidatesBySessionAndGeneration(
          db,
          session.sessionId,
          session.evaluationGeneration,
        );
      if (existingCandidates.length > 0) {
        const updated = await transitionSessionPhase(db, session, "SCORE", now);
        return { isBoundary: false, nextSession: updated };
      }

      const { perception, targetSpec } = await getOrComputePerceptionSnapshot(
        db,
        session,
        cue,
        ports.perception,
        now,
      );
      const context = await assembleCognitiveContext(db, {
        session,
        cue,
        perception,
        targetSpec,
        skillKey: options.skillKey,
        memoryRequests: options.memoryRequests,
      });

      // Invoke candidate generator port OUTSIDE db transaction
      const generated =
        await ports.candidateGenerator.generateCandidates(context);

      for (let idx = 0; idx < generated.length; idx++) {
        const gen = generated[idx];
        if (gen.cueId !== cue.cueId) {
          throw PersistenceError.invalidPersistedState(
            `Cross-cue candidate rejected: candidate cueId "${gen.cueId}" does not match session cueId "${cue.cueId}".`,
          );
        }

        const proposalHash = createCanonicalFingerprint({
          goal: gen.goal,
          action: gen.action,
        }).slice(0, 12);
        const candidateId = `cand:${session.sessionId}:gen${session.evaluationGeneration}:${idx + 1}:${proposalHash}`;

        const candidate: PersistedCandidateAction = {
          candidateId,
          sessionId: session.sessionId,
          cueId: cue.cueId,
          evaluationGeneration: session.evaluationGeneration,
          goal: gen.goal,
          action: gen.action,
          confidence: gen.confidence,
          expectedUtility: gen.expectedUtility,
          estimatedRisk: gen.estimatedRisk,
          estimatedCost: gen.estimatedCost,
          scoreValue: 0.5,
          recommendation: "AUTO_CANDIDATE",
          scoreFormulaVersion: "v1",
          evidenceIds: gen.evidenceIds ?? [],
          createdAt: now,
        };
        await candidateRepository.appendCandidate(db, candidate);
      }

      const updated = await transitionSessionPhase(db, session, "SCORE", now);
      return { isBoundary: false, nextSession: updated };
    }

    case "SCORE": {
      const cue = await getRequiredCue(db, session);
      const candidates =
        await candidateRepository.findCandidatesBySessionAndGeneration(
          db,
          session.sessionId,
          session.evaluationGeneration,
        );

      if (candidates.length === 0) {
        const updated = await transitionSessionPhase(
          db,
          session,
          "CLEAR_WORKING_MEMORY",
          now,
          { currentCandidateId: null },
        );
        return { isBoundary: false, nextSession: updated };
      }

      const { perception, targetSpec } = await getOrComputePerceptionSnapshot(
        db,
        session,
        cue,
        ports.perception,
        now,
      );
      const context = await assembleCognitiveContext(db, {
        session,
        cue,
        perception,
        targetSpec,
        skillKey: options.skillKey,
        memoryRequests: options.memoryRequests,
      });

      const ranked = rankCandidates(candidates, context.learningState);
      const selected = ranked[0];

      if (selected.recommendation === "IGNORE") {
        const updated = await transitionSessionPhase(
          db,
          session,
          "CLEAR_WORKING_MEMORY",
          now,
          { currentCandidateId: null },
        );
        return { isBoundary: false, nextSession: updated };
      }

      if (selected.recommendation === "ASK_HUMAN") {
        const updated = await transitionSessionPhase(
          db,
          session,
          "HUMAN_REVIEW",
          now,
          { currentCandidateId: selected.candidateId },
        );
        return {
          isBoundary: true,
          cycleResult: {
            status: "HUMAN_REVIEW_REQUIRED",
            sessionId,
            reason:
              "Candidate recommendation requires human review (ASK_HUMAN).",
            details: {
              candidateId: selected.candidateId,
              score: selected.finalScore,
            },
          },
          nextSession: updated,
        };
      }

      // AUTO_CANDIDATE: Proceed to GROUND_VERIFY (NOT execution permission!)
      const updated = await transitionSessionPhase(
        db,
        session,
        "GROUND_VERIFY",
        now,
        { currentCandidateId: selected.candidateId },
      );
      return { isBoundary: false, nextSession: updated };
    }

    case "GROUND_VERIFY": {
      if (!session.currentCandidateId) {
        throw PersistenceError.invalidPersistedState(
          "Session in GROUND_VERIFY is missing currentCandidateId.",
        );
      }
      const candidate = await candidateRepository.findCandidateById(
        db,
        session.currentCandidateId,
      );
      if (!candidate) {
        throw PersistenceError.notFound(
          `Candidate "${session.currentCandidateId}" was not found.`,
        );
      }

      if (candidate.evaluationGeneration !== session.evaluationGeneration) {
        throw PersistenceError.stateConflict(
          `Candidate evaluationGeneration (${candidate.evaluationGeneration}) does not match session (${session.evaluationGeneration}).`,
        );
      }

      const cue = await getRequiredCue(db, session);
      const { perception, targetSpec } = await getOrComputePerceptionSnapshot(
        db,
        session,
        cue,
        ports.perception,
        now,
      );
      const context = await assembleCognitiveContext(db, {
        session,
        cue,
        perception,
        targetSpec,
        skillKey: options.skillKey,
        memoryRequests: options.memoryRequests,
      });

      // Call Grounding Evaluator Port OUTSIDE db transaction
      const evaluation = await ports.groundingEvaluator.evaluateGrounding(
        candidate,
        context,
      );

      let persistedStatus: "VERIFIED" | "CONTRADICTED" | "UNVERIFIED";
      if (evaluation.status === "VERIFIED") {
        persistedStatus = "VERIFIED";
      } else if (evaluation.status === "CONFLICTING_EVIDENCE") {
        persistedStatus = "CONTRADICTED";
      } else {
        persistedStatus = "UNVERIFIED";
      }

      const groundingResultId = `grounding:${candidate.candidateId}:v1`;
      const persistedGrounding: PersistedGroundingResult = {
        groundingResultId,
        candidateId: candidate.candidateId,
        evaluationKey: `grounding-eval:${candidate.candidateId}`,
        status: persistedStatus,
        confidence: evaluation.confidence,
        reason: evaluation.reason,
        evaluatorVersion: evaluation.evaluatorVersion,
        evidenceIds: evaluation.evidenceIds,
        evaluatedAt: now,
      };

      await groundingRepository.appendGroundingResult(db, persistedGrounding);

      if (evaluation.status !== "VERIFIED") {
        const updated = await transitionSessionPhase(
          db,
          session,
          "HUMAN_REVIEW",
          now,
        );
        return {
          isBoundary: true,
          cycleResult: {
            status: "HUMAN_REVIEW_REQUIRED",
            sessionId,
            reason: `Grounding evaluation resulted in ${evaluation.status}: ${evaluation.reason}`,
            details: {
              candidateId: candidate.candidateId,
              groundingStatus: evaluation.status,
            },
          },
          nextSession: updated,
        };
      }

      const updated = await transitionSessionPhase(
        db,
        session,
        "POLICY_SAFETY",
        now,
      );
      return { isBoundary: false, nextSession: updated };
    }

    case "POLICY_SAFETY": {
      if (!session.currentCandidateId) {
        throw PersistenceError.invalidPersistedState(
          "Session in POLICY_SAFETY is missing currentCandidateId.",
        );
      }
      const candidate = await candidateRepository.findCandidateById(
        db,
        session.currentCandidateId,
      );
      if (!candidate) {
        throw PersistenceError.notFound(
          `Candidate "${session.currentCandidateId}" not found.`,
        );
      }

      if (candidate.evaluationGeneration !== session.evaluationGeneration) {
        throw PersistenceError.stateConflict(
          `Candidate evaluationGeneration (${candidate.evaluationGeneration}) does not match session (${session.evaluationGeneration}).`,
        );
      }

      const grounding =
        await groundingRepository.findGroundingResultByCandidateId(
          db,
          candidate.candidateId,
        );
      if (!grounding || grounding.status !== "VERIFIED") {
        throw PersistenceError.invalidPersistedState(
          "Valid VERIFIED grounding result required before POLICY_SAFETY evaluation.",
        );
      }

      const cue = await getRequiredCue(db, session);
      const { perception, targetSpec } = await getOrComputePerceptionSnapshot(
        db,
        session,
        cue,
        ports.perception,
        now,
      );
      const context = await assembleCognitiveContext(db, {
        session,
        cue,
        perception,
        targetSpec,
        skillKey: options.skillKey,
        memoryRequests: options.memoryRequests,
      });

      // Call Policy Evaluator Port OUTSIDE db transaction
      const policyEval = await ports.policyEvaluator.evaluatePolicy(
        candidate,
        grounding,
        context,
      );

      let persistedOutcome: "ALLOW" | "DENY" | "REQUIRE_HUMAN_CONFIRMATION";
      if (policyEval.outcome === "ALLOW") {
        persistedOutcome = "ALLOW";
      } else if (policyEval.outcome === "REQUIRE_APPROVAL") {
        persistedOutcome = "REQUIRE_HUMAN_CONFIRMATION";
      } else {
        persistedOutcome = "DENY";
      }

      const policyDecisionId = `policy:${candidate.candidateId}:v1`;
      const persistedPolicy: PersistedPolicyDecision = {
        policyDecisionId,
        candidateId: candidate.candidateId,
        groundingResultId: grounding.groundingResultId,
        evaluationKey: `policy-eval:${candidate.candidateId}`,
        outcome: persistedOutcome,
        reason: policyEval.reason,
        policyEngineVersion: policyEval.policyEngineVersion,
        policyIds: policyEval.policyIds,
        evaluatedAt: now,
      };

      await policyRepository.appendPolicyDecision(db, persistedPolicy);

      if (policyEval.outcome !== "ALLOW") {
        const updated = await transitionSessionPhase(
          db,
          session,
          "HUMAN_REVIEW",
          now,
        );
        return {
          isBoundary: true,
          cycleResult: {
            status: "HUMAN_REVIEW_REQUIRED",
            sessionId,
            reason: `Policy safety evaluated to ${policyEval.outcome}: ${policyEval.reason}`,
            details: {
              candidateId: candidate.candidateId,
              policyOutcome: policyEval.outcome,
            },
          },
          nextSession: updated,
        };
      }

      // Safe ALLOW: Atomically issue runtime execution capability
      const authoritativeSafety =
        await safetyRepository.findSafetyStateBySessionId(db, sessionId);
      if (!authoritativeSafety) {
        throw PersistenceError.notFound(
          `Authoritative safety state not found for session "${sessionId}".`,
        );
      }

      const issued = await orchestrateAuthorizationIssuance(db, {
        commandIdempotencyKey: `auth-issuance:${sessionId}:gen${session.evaluationGeneration}:${authoritativeSafety.generation}`,
        sessionId,
        candidateId: candidate.candidateId,
        groundingResultId: grounding.groundingResultId,
        policyDecisionId: persistedPolicy.policyDecisionId,
        expectedSessionRowVersion: session.rowVersion,
        expectedSafetyGeneration: authoritativeSafety.generation,
        safetyEventId: `ev-safety-auth:${sessionId}:gen${session.evaluationGeneration}:${authoritativeSafety.generation}`,
        safetyEventKey: `ev-key:safety-auth:${sessionId}:gen${session.evaluationGeneration}:${authoritativeSafety.generation}`,
        issuedAt: now,
      });

      if (issued.status !== "AUTHORIZED") {
        throw PersistenceError.stateConflict(
          `Expected AUTHORIZED from authorization issuance, received status "${issued.status}".`,
        );
      }

      return {
        isBoundary: false,
        nextSession: issued.session,
        runtimeAuthorization: issued.authorization,
      };
    }

    case "PLAN": {
      if (!session.currentCandidateId) {
        throw PersistenceError.invalidPersistedState(
          "Session in PLAN phase is missing currentCandidateId.",
        );
      }
      const candidate = await candidateRepository.findCandidateById(
        db,
        session.currentCandidateId,
      );
      if (!candidate) {
        throw PersistenceError.notFound(
          `Candidate "${session.currentCandidateId}" not found.`,
        );
      }

      if (candidate.evaluationGeneration !== session.evaluationGeneration) {
        throw PersistenceError.stateConflict(
          `Candidate evaluationGeneration (${candidate.evaluationGeneration}) does not match session (${session.evaluationGeneration}).`,
        );
      }

      const auth = effectiveAuth;
      if (!auth) {
        // Authorization capability was lost (e.g. process restart).
        // Transition back to BUILD_CONTEXT with incremented evaluationGeneration.
        const resetSession = await sessionRepository.transitionSession(db, {
          sessionId: session.sessionId,
          expectedRowVersion: session.rowVersion,
          expectedPhase: "PLAN",
          expectedCandidateId: session.currentCandidateId,
          nextSessionState: {
            phase: "BUILD_CONTEXT",
            failureCount: session.failureCount,
            retryCount: session.retryCount,
            maxRetries: session.maxRetries,
            evaluationGeneration: session.evaluationGeneration + 1,
            cooldownUntil: session.cooldownUntil,
            currentCandidateId: null,
            currentPlanId: null,
            currentExecutionId: null,
            updatedAt: now,
          },
        });
        return { isBoundary: false, nextSession: resetSession };
      }

      const cue = await getRequiredCue(db, session);
      const { perception, targetSpec } = await getOrComputePerceptionSnapshot(
        db,
        session,
        cue,
        ports.perception,
        now,
      );
      const context = await assembleCognitiveContext(db, {
        session,
        cue,
        perception,
        targetSpec,
        skillKey: options.skillKey,
        memoryRequests: options.memoryRequests,
      });

      // Call Plan Builder Port OUTSIDE db transaction
      const proposedPlan = await ports.planBuilder.buildPlan(
        candidate,
        context,
      );

      // Enforce single-step execution at plan validation boundary BEFORE execution preparation
      if (proposedPlan.steps.length !== 1) {
        throw PersistenceError.invalidPersistedState(
          `Action plan "${proposedPlan.planId}" contains ${proposedPlan.steps.length} steps. The current runtime executor explicitly supports single-step plans only.`,
          { planId: proposedPlan.planId, stepCount: proposedPlan.steps.length },
        );
      }

      const planRecord: PersistedActionPlan = {
        planId: proposedPlan.planId,
        candidateId: candidate.candidateId,
        planGeneration: proposedPlan.planGeneration,
        steps: proposedPlan.steps,
        dependencies: proposedPlan.dependencies ?? [],
        createdAt: now,
      };

      await planRepository.appendPlan(db, planRecord);

      // Prepare authorized execution
      const executionId = `exec:${session.sessionId}:${proposedPlan.planId}`;
      await prepareAuthorizedExecution(db, auth, {
        commandIdempotencyKey: `prep-exec:${executionId}`,
        executionId,
        sessionId: session.sessionId,
        planId: proposedPlan.planId,
        expectedSessionRowVersion: session.rowVersion,
        expectedSafetyGeneration: auth.generation,
        createdAt: now,
      });

      const updatedSession = await sessionRepository.findSessionById(
        db,
        session.sessionId,
      );
      if (!updatedSession) {
        throw PersistenceError.notFound(
          `Session "${session.sessionId}" not found after preparation.`,
        );
      }

      return {
        isBoundary: false,
        nextSession: updatedSession,
        runtimeAuthorization: auth,
      };
    }

    case "DURABLE_EXECUTION": {
      const plan = await getRequiredPlan(db, session);
      if (plan.steps.length !== 1) {
        throw PersistenceError.invalidPersistedState(
          `Action plan "${plan.planId}" has ${plan.steps.length} steps; single-step runtime only supported.`,
        );
      }

      const executionId = `exec:${session.sessionId}:${plan.planId}`;
      const firstStep = plan.steps[0];
      const operationId = `op:${executionId}:${firstStep.stepId}`;

      const auth = effectiveAuth;
      if (!auth) {
        const op = await executionOperationRepository.findOperationById(
          db,
          operationId,
        );

        // Crash resume check 1: If operation already SUCCEEDED, finalize execution idempotently and advance to OBSERVE
        if (op && op.status === "SUCCEEDED") {
          const freshStep = await executionStepRepository.findStep(
            db,
            executionId,
            firstStep.stepId,
          );
          const freshExec = await executionRepository.findExecutionById(
            db,
            executionId,
          );
          if (freshStep && freshStep.status !== "SUCCEEDED" && freshExec) {
            const completedStep = await completeExecutionStep(db, {
              commandIdempotencyKey: `complete-step:${executionId}:${firstStep.stepId}`,
              executionEventId: `ev-comp-step:${executionId}:${firstStep.stepId}`,
              eventKey: `ev-key:comp-step:${executionId}:${firstStep.stepId}`,
              executionId,
              planId: plan.planId,
              stepId: firstStep.stepId,
              operationGeneration: 1,
              expectedExecutionRowVersion: freshExec.rowVersion,
              expectedStepRowVersion: freshStep.rowVersion,
              completedAt: now,
              reason: "Successful operation.",
            });
            if (completedStep.execution.status !== "SUCCEEDED") {
              await finalizeExecutionIfComplete(db, {
                commandIdempotencyKey: `finalize-exec:${executionId}`,
                executionEventId: `ev-fin-exec:${executionId}`,
                eventKey: `ev-key:fin-exec:${executionId}`,
                executionId,
                expectedExecutionRowVersion: completedStep.execution.rowVersion,
                completedAt: now,
                reason: "All steps succeeded.",
              });
            }
          }
          const updated = await transitionSessionPhase(
            db,
            session,
            "OBSERVE",
            now,
          );
          return { isBoundary: false, nextSession: updated };
        }

        // Crash resume check 2: If operation already FAILED, finalize failure ledgers idempotently and advance to OBSERVE
        if (op && op.status === "FAILED") {
          const freshStep = await executionStepRepository.findStep(
            db,
            executionId,
            firstStep.stepId,
          );
          const freshExec = await executionRepository.findExecutionById(
            db,
            executionId,
          );
          if (freshStep && freshStep.status !== "FAILED" && freshExec) {
            const failedStep = await failExecutionStep(db, {
              commandIdempotencyKey: `fail-step:${executionId}:${firstStep.stepId}`,
              executionEventId: `ev-fail-step:${executionId}:${firstStep.stepId}`,
              eventKey: `ev-key:fail-step:${executionId}:${firstStep.stepId}`,
              executionId,
              planId: plan.planId,
              stepId: firstStep.stepId,
              operationGeneration: 1,
              expectedExecutionRowVersion: freshExec.rowVersion,
              expectedStepRowVersion: freshStep.rowVersion,
              completedAt: now,
              errorSummary: op.uncertaintyReason ?? "Operation failed.",
            });
            if (failedStep.execution.status !== "FAILED") {
              await finalizeExecutionFailure(db, {
                commandIdempotencyKey: `finalize-fail-exec:${executionId}`,
                executionEventId: `ev-fin-fail-exec:${executionId}`,
                eventKey: `ev-key:fin-fail-exec:${executionId}`,
                executionId,
                expectedExecutionRowVersion: failedStep.execution.rowVersion,
                completedAt: now,
                errorSummary: op.uncertaintyReason ?? "Operation failed.",
              });
            }
          }
          const updated = await transitionSessionPhase(
            db,
            session,
            "OBSERVE",
            now,
          );
          return { isBoundary: false, nextSession: updated };
        }

        // Reconciliation check: if operation is IN_FLIGHT or UNKNOWN
        if (op && op.status === "IN_FLIGHT" && op.attemptCount > 0) {
          return {
            isBoundary: true,
            cycleResult: {
              status: "RECONCILIATION_REQUIRED",
              sessionId,
              executionId,
              operationId,
              reason: "Operation is IN_FLIGHT; reconciliation required.",
            },
            nextSession: session,
          };
        }
        if (op && op.status === "UNKNOWN") {
          return {
            isBoundary: true,
            cycleResult: {
              status: "RECONCILIATION_REQUIRED",
              sessionId,
              executionId,
              operationId,
              reason: "Operation outcome is UNKNOWN; reconciliation required.",
            },
            nextSession: session,
          };
        }

        // Operation is PENDING (attemptCount === 0) or unstarted: terminalize pending execution records safely before resetting
        const existingExec = await executionRepository.findExecutionById(
          db,
          executionId,
        );
        if (existingExec) {
          const step = await executionStepRepository.findStep(
            db,
            executionId,
            firstStep.stepId,
          );
          if (
            step &&
            (step.status === "PENDING" || step.status === "RUNNING")
          ) {
            await failExecutionStep(db, {
              commandIdempotencyKey: `abort-step:${executionId}:${firstStep.stepId}`,
              executionEventId: `ev-abort-step:${executionId}:${firstStep.stepId}`,
              eventKey: `ev-key:abort-step:${executionId}:${firstStep.stepId}`,
              executionId,
              planId: plan.planId,
              stepId: firstStep.stepId,
              operationGeneration: 1,
              expectedExecutionRowVersion: existingExec.rowVersion,
              expectedStepRowVersion: step.rowVersion,
              completedAt: now,
              errorSummary:
                "Execution aborted due to lost runtime authorization before dispatch.",
            }).catch(() => {});
          }

          const freshExec = await executionRepository.findExecutionById(
            db,
            executionId,
          );
          if (
            freshExec &&
            (freshExec.status === "PENDING" || freshExec.status === "RUNNING")
          ) {
            await finalizeExecutionFailure(db, {
              commandIdempotencyKey: `abort-exec:${executionId}`,
              executionEventId: `ev-abort-exec:${executionId}`,
              eventKey: `ev-key:abort-exec:${executionId}`,
              executionId,
              expectedExecutionRowVersion: freshExec.rowVersion,
              completedAt: now,
              errorSummary:
                "Execution aborted due to lost runtime authorization before dispatch.",
            }).catch(() => {});
          }
        }

        const resetSession = await sessionRepository.transitionSession(db, {
          sessionId: session.sessionId,
          expectedRowVersion: session.rowVersion,
          expectedPhase: "DURABLE_EXECUTION",
          expectedCandidateId: session.currentCandidateId,
          nextSessionState: {
            phase: "BUILD_CONTEXT",
            failureCount: session.failureCount,
            retryCount: session.retryCount,
            maxRetries: session.maxRetries,
            evaluationGeneration: session.evaluationGeneration + 1,
            cooldownUntil: session.cooldownUntil,
            currentCandidateId: null,
            currentPlanId: null,
            currentExecutionId: null,
            updatedAt: now,
          },
        });
        return { isBoundary: false, nextSession: resetSession };
      }

      const existingExec = await executionRepository.findExecutionById(
        db,
        executionId,
      );
      if (!existingExec) {
        throw PersistenceError.notFound(
          `Execution "${executionId}" not found for session in DURABLE_EXECUTION phase.`,
        );
      }

      const candidate = await getRequiredCandidate(db, session);
      const cue = await getRequiredCue(db, session);
      const { perception, targetSpec } = await getOrComputePerceptionSnapshot(
        db,
        session,
        cue,
        ports.perception,
        now,
      );
      const context = await assembleCognitiveContext(db, {
        session,
        cue,
        perception,
        targetSpec,
        skillKey: options.skillKey,
        memoryRequests: options.memoryRequests,
      });

      const requestBuilder =
        ports.requestBuilder ?? new DefaultOperationRequestBuilder();
      const builtRequest = requestBuilder.buildOperationRequest(
        candidate,
        plan,
        firstStep,
        context,
      );

      // Start execution and first step if PENDING
      if (existingExec.status === "PENDING") {
        await startAuthorizedExecution(db, auth, {
          commandIdempotencyKey: `start-exec:${executionId}`,
          executionEventId: `ev-start-exec:${executionId}`,
          eventKey: `event-key:start:${executionId}`,
          executionId,
          sessionId: session.sessionId,
          planId: plan.planId,
          expectedExecutionRowVersion: existingExec.rowVersion,
          expectedSafetyGeneration: auth.generation,
          startedAt: now,
          reason: "Autonomous cognitive cycle start.",
        });

        await startAuthorizedExecutionStep(db, auth, {
          commandIdempotencyKey: `start-step:${executionId}:${firstStep.stepId}`,
          executionEventId: `ev-start-step:${executionId}:${firstStep.stepId}`,
          eventKey: `event-key:start-step:${executionId}:${firstStep.stepId}`,
          executionId,
          sessionId: session.sessionId,
          planId: plan.planId,
          stepId: firstStep.stepId,
          expectedExecutionRowVersion: existingExec.rowVersion + 1,
          expectedStepRowVersion: 0,
          expectedSafetyGeneration: auth.generation,
          startedAt: now,
          reason: "Autonomous step execution start.",
        });

        // Reserve operation in Transaction A (marks operation IN_FLIGHT)
        await reserveAuthorizedExecutionOperation(db, auth, {
          commandIdempotencyKey: `reserve-op:${operationId}`,
          operationId,
          executionId,
          sessionId: session.sessionId,
          planId: plan.planId,
          stepId: firstStep.stepId,
          operationGeneration: 1,
          expectedStepRowVersion: 1,
          expectedSafetyGeneration: auth.generation,
          operationKind: builtRequest.operationKind,
          requestFingerprint: builtRequest.requestFingerprint,
          providerScope: builtRequest.providerScope,
          providerIdempotencyKey: builtRequest.providerIdempotencyKey,
          createdAt: now,
        });
      }

      // Transition session from DURABLE_EXECUTION to ACT
      const updated = await transitionSessionPhase(db, session, "ACT", now, {
        currentExecutionId: executionId,
      });
      return {
        isBoundary: false,
        nextSession: updated,
        runtimeAuthorization: auth,
      };
    }

    case "ACT": {
      const plan = await getRequiredPlan(db, session);
      if (plan.steps.length !== 1) {
        throw PersistenceError.invalidPersistedState(
          `Action plan "${plan.planId}" has ${plan.steps.length} steps; single-step runtime only supported.`,
        );
      }

      const executionId = `exec:${session.sessionId}:${plan.planId}`;
      const firstStep = plan.steps[0];
      const operationId = `op:${executionId}:${firstStep.stepId}`;

      const op = await executionOperationRepository.findOperationById(
        db,
        operationId,
      );
      if (!op) {
        throw PersistenceError.notFound(
          `Operation "${operationId}" not found in ACT phase.`,
        );
      }

      // Crash resume check 1: If operation already SUCCEEDED, finalize ledgers idempotently and advance to OBSERVE
      if (op.status === "SUCCEEDED") {
        const freshStep = await executionStepRepository.findStep(
          db,
          executionId,
          firstStep.stepId,
        );
        const freshExec = await executionRepository.findExecutionById(
          db,
          executionId,
        );
        if (freshStep && freshStep.status !== "SUCCEEDED" && freshExec) {
          const completed = await completeExecutionStep(db, {
            commandIdempotencyKey: `complete-step:${executionId}:${firstStep.stepId}`,
            executionEventId: `ev-comp-step:${executionId}:${firstStep.stepId}`,
            eventKey: `ev-key:comp-step:${executionId}:${firstStep.stepId}`,
            executionId,
            planId: plan.planId,
            stepId: firstStep.stepId,
            operationGeneration: 1,
            expectedExecutionRowVersion: freshExec.rowVersion,
            expectedStepRowVersion: freshStep.rowVersion,
            completedAt: now,
            reason: "Successful operation.",
          });
          if (completed.execution.status !== "SUCCEEDED") {
            await finalizeExecutionIfComplete(db, {
              commandIdempotencyKey: `finalize-exec:${executionId}`,
              executionEventId: `ev-fin-exec:${executionId}`,
              eventKey: `ev-key:fin-exec:${executionId}`,
              executionId,
              expectedExecutionRowVersion: completed.execution.rowVersion,
              completedAt: now,
              reason: "All steps succeeded.",
            });
          }
        }
        const updated = await transitionSessionPhase(
          db,
          session,
          "OBSERVE",
          now,
        );
        return { isBoundary: false, nextSession: updated };
      }

      // Crash resume check 2: If operation already FAILED, finalize failure ledgers idempotently and advance to OBSERVE
      if (op.status === "FAILED") {
        const freshStep = await executionStepRepository.findStep(
          db,
          executionId,
          firstStep.stepId,
        );
        const freshExec = await executionRepository.findExecutionById(
          db,
          executionId,
        );
        if (freshStep && freshStep.status !== "FAILED" && freshExec) {
          const failedStep = await failExecutionStep(db, {
            commandIdempotencyKey: `fail-step:${executionId}:${firstStep.stepId}`,
            executionEventId: `ev-fail-step:${executionId}:${firstStep.stepId}`,
            eventKey: `ev-key:fail-step:${executionId}:${firstStep.stepId}`,
            executionId,
            planId: plan.planId,
            stepId: firstStep.stepId,
            operationGeneration: 1,
            expectedExecutionRowVersion: freshExec.rowVersion,
            expectedStepRowVersion: freshStep.rowVersion,
            completedAt: now,
            errorSummary: op.uncertaintyReason ?? "Operation failed.",
          });
          if (failedStep.execution.status !== "FAILED") {
            await finalizeExecutionFailure(db, {
              commandIdempotencyKey: `finalize-fail-exec:${executionId}`,
              executionEventId: `ev-fin-fail-exec:${executionId}`,
              eventKey: `ev-key:fin-fail-exec:${executionId}`,
              executionId,
              expectedExecutionRowVersion: failedStep.execution.rowVersion,
              completedAt: now,
              errorSummary: op.uncertaintyReason ?? "Operation failed.",
            });
          }
        }
        const updated = await transitionSessionPhase(
          db,
          session,
          "OBSERVE",
          now,
        );
        return { isBoundary: false, nextSession: updated };
      }

      if (op.status === "IN_FLIGHT" && op.attemptCount > 0) {
        return {
          isBoundary: true,
          cycleResult: {
            status: "RECONCILIATION_REQUIRED",
            sessionId,
            executionId,
            operationId,
            reason: "Operation is IN_FLIGHT; reconciliation required.",
          },
          nextSession: session,
        };
      }
      if (op.status === "UNKNOWN") {
        return {
          isBoundary: true,
          cycleResult: {
            status: "RECONCILIATION_REQUIRED",
            sessionId,
            executionId,
            operationId,
            reason: "Operation outcome is UNKNOWN; reconciliation required.",
          },
          nextSession: session,
        };
      }

      // External dispatch has not occurred: require live runtime authorization capability
      const auth = effectiveAuth;
      if (!auth) {
        // Terminalize old execution safely
        const freshStep = await executionStepRepository.findStep(
          db,
          executionId,
          firstStep.stepId,
        );
        const freshExec = await executionRepository.findExecutionById(
          db,
          executionId,
        );
        if (
          freshStep &&
          (freshStep.status === "PENDING" || freshStep.status === "RUNNING") &&
          freshExec
        ) {
          const failedStep = await failExecutionStep(db, {
            commandIdempotencyKey: `abort-act-step:${executionId}:${firstStep.stepId}`,
            executionEventId: `ev-abort-act-step:${executionId}:${firstStep.stepId}`,
            eventKey: `ev-key:abort-act-step:${executionId}:${firstStep.stepId}`,
            executionId,
            planId: plan.planId,
            stepId: firstStep.stepId,
            operationGeneration: 1,
            expectedExecutionRowVersion: freshExec.rowVersion,
            expectedStepRowVersion: freshStep.rowVersion,
            completedAt: now,
            errorSummary:
              "Execution aborted due to lost runtime authorization before dispatch.",
          }).catch(() => null);

          if (failedStep && failedStep.execution.status !== "FAILED") {
            await finalizeExecutionFailure(db, {
              commandIdempotencyKey: `abort-act-exec:${executionId}`,
              executionEventId: `ev-abort-act-exec:${executionId}`,
              eventKey: `ev-key:abort-act-exec:${executionId}`,
              executionId,
              expectedExecutionRowVersion: failedStep.execution.rowVersion,
              completedAt: now,
              errorSummary:
                "Execution aborted due to lost runtime authorization before dispatch.",
            }).catch(() => {});
          }
        }

        const resetSession = await sessionRepository.transitionSession(db, {
          sessionId: session.sessionId,
          expectedRowVersion: session.rowVersion,
          expectedPhase: "ACT",
          expectedCandidateId: session.currentCandidateId,
          nextSessionState: {
            phase: "BUILD_CONTEXT",
            failureCount: session.failureCount,
            retryCount: session.retryCount,
            maxRetries: session.maxRetries,
            evaluationGeneration: session.evaluationGeneration + 1,
            cooldownUntil: session.cooldownUntil,
            currentCandidateId: null,
            currentPlanId: null,
            currentExecutionId: null,
            updatedAt: now,
          },
        });
        return { isBoundary: false, nextSession: resetSession };
      }

      const candidate = await getRequiredCandidate(db, session);
      const cue = await getRequiredCue(db, session);
      const { perception, targetSpec } = await getOrComputePerceptionSnapshot(
        db,
        session,
        cue,
        ports.perception,
        now,
      );
      const context = await assembleCognitiveContext(db, {
        session,
        cue,
        perception,
        targetSpec,
        skillKey: options.skillKey,
        memoryRequests: options.memoryRequests,
      });

      const requestBuilder =
        ports.requestBuilder ?? new DefaultOperationRequestBuilder();
      const builtRequest = requestBuilder.buildOperationRequest(
        candidate,
        plan,
        firstStep,
        context,
      );

      // Dispatch operation OUTSIDE db transaction
      const dispatchResult = await dispatchAuthorizedOperation(
        db,
        auth,
        ports.adapter,
        {
          commandIdempotencyKey: `dispatch:${operationId}:attempt:1`,
          operationId,
          attemptId: `att:${operationId}:1`,
          executionId,
          sessionId: session.sessionId,
          planId: plan.planId,
          stepId: firstStep.stepId,
          operationGeneration: 1,
          expectedOperationRowVersion: op.rowVersion,
          expectedSafetyGeneration: auth.generation,
          workerId: null,
          startedAt: now,
          request: builtRequest.request as JSONObject,
        },
      );

      if (dispatchResult.dispatchResult.outcome === "INDETERMINATE") {
        return {
          isBoundary: true,
          cycleResult: {
            status: "RECONCILIATION_REQUIRED",
            sessionId,
            executionId,
            operationId,
            reason:
              "Adapter dispatch resulted in UNKNOWN/INDETERMINATE. Reconciliation required.",
          },
          nextSession: session,
        };
      }

      // Reload fresh row versions and finalize step and execution
      const freshStep = await executionStepRepository.findStep(
        db,
        executionId,
        firstStep.stepId,
      );
      const freshExec = await executionRepository.findExecutionById(
        db,
        executionId,
      );

      if (
        freshStep &&
        freshExec &&
        dispatchResult.dispatchResult.outcome === "CONFIRMED_SUCCESS"
      ) {
        const completed = await completeExecutionStep(db, {
          commandIdempotencyKey: `complete-step:${executionId}:${firstStep.stepId}`,
          executionEventId: `ev-comp-step:${executionId}:${firstStep.stepId}`,
          eventKey: `ev-key:comp-step:${executionId}:${firstStep.stepId}`,
          executionId,
          planId: plan.planId,
          stepId: firstStep.stepId,
          operationGeneration: 1,
          expectedExecutionRowVersion: freshExec.rowVersion,
          expectedStepRowVersion: freshStep.rowVersion,
          completedAt: now,
          reason: "Successful operation.",
        });
        if (completed.execution.status !== "SUCCEEDED") {
          await finalizeExecutionIfComplete(db, {
            commandIdempotencyKey: `finalize-exec:${executionId}`,
            executionEventId: `ev-fin-exec:${executionId}`,
            eventKey: `ev-key:fin-exec:${executionId}`,
            executionId,
            expectedExecutionRowVersion: completed.execution.rowVersion,
            completedAt: now,
            reason: "All steps succeeded.",
          });
        }
      } else if (freshStep && freshExec) {
        const errorSummary =
          "errorSummary" in dispatchResult.dispatchResult &&
          typeof dispatchResult.dispatchResult.errorSummary === "string"
            ? dispatchResult.dispatchResult.errorSummary
            : "Operation failed.";

        const failedStep = await failExecutionStep(db, {
          commandIdempotencyKey: `fail-step:${executionId}:${firstStep.stepId}`,
          executionEventId: `ev-fail-step:${executionId}:${firstStep.stepId}`,
          eventKey: `ev-key:fail-step:${executionId}:${firstStep.stepId}`,
          executionId,
          planId: plan.planId,
          stepId: firstStep.stepId,
          operationGeneration: 1,
          expectedExecutionRowVersion: freshExec.rowVersion,
          expectedStepRowVersion: freshStep.rowVersion,
          completedAt: now,
          errorSummary,
        });
        if (failedStep.execution.status !== "FAILED") {
          await finalizeExecutionFailure(db, {
            commandIdempotencyKey: `finalize-fail-exec:${executionId}`,
            executionEventId: `ev-fin-fail-exec:${executionId}`,
            eventKey: `ev-key:fin-fail-exec:${executionId}`,
            executionId,
            expectedExecutionRowVersion: failedStep.execution.rowVersion,
            completedAt: now,
            errorSummary,
          });
        }
      }

      // Transition session from ACT to OBSERVE
      const updated = await transitionSessionPhase(db, session, "OBSERVE", now);
      return { isBoundary: false, nextSession: updated };
    }

    case "OBSERVE": {
      const plan = await getRequiredPlan(db, session);
      if (plan.steps.length !== 1) {
        throw PersistenceError.invalidPersistedState(
          `Action plan "${plan.planId}" has ${plan.steps.length} steps; single-step runtime only supported.`,
        );
      }

      const executionId = `exec:${session.sessionId}:${plan.planId}`;
      const firstStep = plan.steps[0];
      const operationId = `op:${executionId}:${firstStep.stepId}`;
      const attemptId = `att:${operationId}:1`;
      const observationId = `obs:${executionId}:${firstStep.stepId}`;

      const op = await executionOperationRepository.findOperationById(
        db,
        operationId,
      );
      if (!op) {
        throw PersistenceError.notFound(
          `Operation "${operationId}" not found in OBSERVE phase.`,
        );
      }

      const attempt = await executionOperationRepository.findAttemptById(
        db,
        attemptId,
      );

      const isSuccess = op.status === "SUCCEEDED";
      const durableResult = (attempt?.providerMetadata ??
        null) as JSONObject | null;

      if (
        isSuccess &&
        (!durableResult || Object.keys(durableResult).length === 0)
      ) {
        return {
          isBoundary: true,
          cycleResult: {
            status: "FAILED",
            sessionId,
            executionId,
            reason: `Operation "${operationId}" is marked SUCCEEDED but missing durable provider result payload.`,
          },
          nextSession: session,
        };
      }

      const observationData: JSONObject = isSuccess
        ? {
            outcome: "CONFIRMED_SUCCESS",
            operationKind: op.operationKind,
            providerScope: op.providerScope ?? "github-rest",
            providerOperationId: op.providerOperationId,
            result: durableResult ?? {},
            finishedAt: attempt?.finishedAt ?? op.updatedAt,
          }
        : {
            outcome: "CONFIRMED_FAILURE",
            operationKind: op.operationKind,
            errorSummary:
              attempt?.errorSummary ??
              op.uncertaintyReason ??
              "Operation did not confirm success",
            finishedAt: attempt?.finishedAt ?? op.updatedAt,
          };

      await recordObservation(db, {
        commandIdempotencyKey: `ingest-obs:${observationId}`,
        observationId,
        executionId,
        stepId: firstStep.stepId,
        source: "provider-dispatch",
        sourceEventId: `event-${observationId}`,
        summary: `Dispatch observation for ${op.operationKind}`,
        data: observationData,
        observedAt: now,
        payloadExpiresAt: null,
      });

      const evidence: PersistedEvidence = {
        evidenceId: `ev-${observationId}`,
        source: "verification",
        sourceId: observationId,
        claim: isSuccess
          ? `Execution result confirmed for ${op.operationKind}`
          : `Execution result failed for ${op.operationKind}`,
        observedAt: now,
        createdAt: now,
        providerMetadata: { executionId, operationId },
      };
      await evidenceRepository.appendEvidence(db, evidence);

      const updated = await transitionSessionPhase(
        db,
        session,
        "VERIFY_RESULT",
        now,
      );
      return { isBoundary: false, nextSession: updated };
    }

    case "VERIFY_RESULT": {
      const plan = await getRequiredPlan(db, session);
      if (plan.steps.length !== 1) {
        throw PersistenceError.invalidPersistedState(
          `Action plan "${plan.planId}" has ${plan.steps.length} steps; single-step runtime only supported.`,
        );
      }

      const executionId = `exec:${session.sessionId}:${plan.planId}`;
      const firstStep = plan.steps[0];
      const observationId = `obs:${executionId}:${firstStep.stepId}`;
      const verificationId = `ver:${executionId}`;

      const cue = await getRequiredCue(db, session);
      const { targetSpec } = await getOrComputePerceptionSnapshot(
        db,
        session,
        cue,
        ports.perception,
        now,
      );

      await verifyExecutionResult(db, ports.verifier, {
        commandIdempotencyKey: `verify:${verificationId}`,
        verificationId,
        executionId,
        observationIds: [observationId],
        expectedVerificationGeneration: 1,
        verifierVersion: ports.verifier.version,
        verifiedAt: now,
        expectedResult: targetSpec as unknown as JSONObject,
      });

      const updated = await transitionSessionPhase(db, session, "REWARD", now);
      return { isBoundary: false, nextSession: updated };
    }

    case "REWARD": {
      const plan = await getRequiredPlan(db, session);
      const executionId = `exec:${session.sessionId}:${plan.planId}`;
      const verificationId = `ver:${executionId}`;

      const verification = await verificationRepository.findVerificationById(
        db,
        verificationId,
      );
      if (!verification) {
        throw PersistenceError.notFound(
          `Verification "${verificationId}" not found.`,
        );
      }

      const defaultReward = getDefaultRewardForVerificationStatus(
        verification.status,
      );

      // Apply canonical reward + learning state projection
      await applyVerificationReward(db, {
        commandIdempotencyKey: `reward:${verificationId}:${defaultReward.rewardRuleId}`,
        rewardEventId: `rew:${verificationId}`,
        executionId,
        verificationId,
        rewardRuleId: defaultReward.rewardRuleId,
        signal: defaultReward.signal,
        value: defaultReward.value,
        skillKey: options.skillKey,
        reason: defaultReward.reason,
        createdAt: now,
      });

      const updated = await transitionSessionPhase(db, session, "LEARN", now);
      return { isBoundary: false, nextSession: updated };
    }

    case "LEARN": {
      const plan = await getRequiredPlan(db, session);
      const executionId = `exec:${session.sessionId}:${plan.planId}`;
      const verificationId = `ver:${executionId}`;

      const verification = await verificationRepository.findVerificationById(
        db,
        verificationId,
      );
      if (!verification) {
        throw PersistenceError.notFound(
          `Verification "${verificationId}" not found.`,
        );
      }

      // Confirm durable learning projection exists
      const learningState = await learningRepository.findLearningState(
        db,
        options.skillKey,
      );
      if (!learningState) {
        throw PersistenceError.invalidPersistedState(
          `Learning state projection for skill "${options.skillKey}" not found in LEARN phase.`,
        );
      }

      if (verification.status === "VERIFIED") {
        const updated = await transitionSessionPhase(
          db,
          session,
          "SAVE_MEMORY",
          now,
        );
        return { isBoundary: false, nextSession: updated };
      }

      // For FAILED or INCONCLUSIVE verifications, orchestrate failure recovery
      const authoritativeSafety =
        await safetyRepository.findSafetyStateBySessionId(db, sessionId);
      if (!authoritativeSafety) {
        throw PersistenceError.notFound(
          `Safety state for session "${sessionId}" not found.`,
        );
      }

      const recoveryResult = await persistFailureRecovery(db, {
        commandIdempotencyKey: `fail-rec:${session.sessionId}:gen${session.evaluationGeneration}:${session.rowVersion}`,
        sessionId: session.sessionId,
        expectedSessionRowVersion: session.rowVersion,
        expectedSafetyGeneration: authoritativeSafety.generation,
        failure: "UNVERIFIED_RESULT",
        reason: `Execution result was ${verification.status}: ${verification.reason}`,
        evidenceIds: [`ev-obs:${executionId}:${plan.steps[0].stepId}`],
        auditEventId: `audit:${session.sessionId}:gen${session.evaluationGeneration}:${session.failureCount + 1}`,
        safetyEventId: `ev-safety-rec:${session.sessionId}:gen${session.evaluationGeneration}:${authoritativeSafety.generation + 1}`,
        safetyEventKey: `ev-key:safety-rec:${session.sessionId}:gen${session.evaluationGeneration}:${authoritativeSafety.generation + 1}`,
        candidateId: session.currentCandidateId,
        planId: plan.planId,
        createdAt: now,
      });

      if (recoveryResult.decision.action === "RETRY_WITH_FRESH_CONTEXT") {
        return {
          isBoundary: false,
          nextSession: recoveryResult.session,
        };
      } else if (recoveryResult.decision.action === "START_COOLDOWN") {
        const cooldownInspection = inspectRecoveryState(
          recoveryResult.session,
          now,
        );
        return {
          isBoundary: true,
          cycleResult: {
            status: "COOLDOWN",
            sessionId,
            cooldownUntil: recoveryResult.session.cooldownUntil ?? now,
            remainingMs:
              cooldownInspection.status === "COOLDOWN_ACTIVE"
                ? cooldownInspection.remainingMs
                : 240_000,
          },
          nextSession: recoveryResult.session,
        };
      } else {
        return {
          isBoundary: true,
          cycleResult: {
            status: "HUMAN_REVIEW_REQUIRED",
            sessionId,
            reason: `Failure recovery resulted in ${recoveryResult.decision.action}: ${recoveryResult.decision.reason}`,
            details: {
              failureCount: recoveryResult.session.failureCount,
              retryCount: recoveryResult.session.retryCount,
              verificationStatus: verification.status,
            },
          },
          nextSession: recoveryResult.session,
        };
      }
    }

    case "SAVE_MEMORY": {
      const plan = await getRequiredPlan(db, session);
      const executionId = `exec:${session.sessionId}:${plan.planId}`;
      const verificationId = `ver:${executionId}`;

      const exec = await executionRepository.findExecutionById(db, executionId);
      const ver = await verificationRepository.findVerificationById(
        db,
        verificationId,
      );
      const obsList =
        await observationRepository.findManyObservationsByExecutionId(
          db,
          executionId,
        );

      if (
        ports.memoryProposalStrategy &&
        exec &&
        ver &&
        ver.status === "VERIFIED"
      ) {
        const proposals =
          await ports.memoryProposalStrategy.proposeVerifiedMemory(
            exec,
            ver,
            obsList,
          );

        for (const prop of proposals) {
          await admitVerifiedMemory(db, {
            commandIdempotencyKey: `mem-cmd:${prop.memoryId}`,
            memoryId: prop.memoryId,
            executionId,
            verificationId,
            kind: prop.kind,
            key: prop.key,
            version: prop.version,
            content: prop.content,
            sourceIds: prop.sourceIds,
            confidence: prop.confidence,
            admissionRuleVersion: prop.admissionRuleVersion,
            verifiedAt: ver.verifiedAt,
            createdAt: now,
          });
        }
      }

      const updated = await transitionSessionPhase(
        db,
        session,
        "CLEAR_WORKING_MEMORY",
        now,
      );
      return { isBoundary: false, nextSession: updated };
    }

    case "CLEAR_WORKING_MEMORY": {
      const plan = session.currentCandidateId
        ? await planRepository
            .findPlanByCandidateId(db, session.currentCandidateId)
            .catch(() => null)
        : null;

      const executionId =
        session.currentExecutionId ??
        (plan ? `exec:${session.sessionId}:${plan.planId}` : null);

      const verification = executionId
        ? await verificationRepository
            .findVerificationById(db, `ver:${executionId}`)
            .catch(() => null)
        : null;

      const memoriesAdmittedCount = verification
        ? await memoryRepository
            .countAdmittedMemoriesByVerification(
              db,
              verification.verificationId,
            )
            .catch(() => 0)
        : 0;

      const updated = await transitionSessionPhase(db, session, "IDLE", now, {
        currentCandidateId: null,
        currentPlanId: null,
        currentExecutionId: null,
      });

      if (executionId && verification) {
        const isVerified = verification.status === "VERIFIED";
        const exec = await executionRepository.findExecutionById(
          db,
          executionId,
        );
        const isExecutionSucceeded = exec?.status === "SUCCEEDED";

        // Defensive checks: all execution steps must be SUCCEEDED and durable operation must be SUCCEEDED
        const steps = await executionStepRepository.listSteps(db, executionId);
        const allStepsSucceeded =
          steps.length > 0 && steps.every((s) => s.status === "SUCCEEDED");

        const firstStep = plan?.steps[0] ?? steps[0];
        const operationId = firstStep
          ? `op:${executionId}:${firstStep.stepId}`
          : null;
        const op = operationId
          ? await executionOperationRepository.findOperationById(
              db,
              operationId,
            )
          : null;
        const isOperationSucceeded = op?.status === "SUCCEEDED";

        const isTerminalComplete =
          isVerified &&
          isExecutionSucceeded &&
          allStepsSucceeded &&
          isOperationSucceeded;

        return {
          isBoundary: true,
          cycleResult: {
            status: isTerminalComplete ? "COMPLETED" : "FAILED",
            sessionId,
            executionId,
            verificationId: verification.verificationId,
            rewardEventId: `rew:${verification.verificationId}`,
            memoriesAdmitted: isTerminalComplete ? memoriesAdmittedCount : 0,
            reason: `Verification status was ${verification.status}, execution status was ${exec?.status ?? "unknown"}, steps ${allStepsSucceeded ? "SUCCEEDED" : "NOT_ALL_SUCCEEDED"}, operation ${op?.status ?? "unknown"}.`,
          },
          nextSession: updated,
        };
      }

      return {
        isBoundary: true,
        cycleResult: {
          status: "NO_ACTION",
          sessionId,
          reason: "Working context cleared; session returned to IDLE.",
        },
        nextSession: updated,
      };
    }

    case "COOLDOWN": {
      const inspection = inspectRecoveryState(session, now);
      if (inspection.status === "COOLDOWN_ACTIVE") {
        return {
          isBoundary: true,
          cycleResult: {
            status: "COOLDOWN",
            sessionId,
            cooldownUntil: inspection.cooldownUntil,
            remainingMs: inspection.remainingMs,
          },
          nextSession: session,
        };
      }
      if (inspection.status === "COOLDOWN_READY") {
        const recovery = await orchestrateRecoverySession(db, {
          sessionId,
          now,
        });
        if (recovery.status === "RESUMED_TO_BUILD_CONTEXT") {
          return { isBoundary: false, nextSession: recovery.session };
        }
        return {
          isBoundary: true,
          cycleResult: {
            status: "HUMAN_REVIEW_REQUIRED",
            sessionId,
            reason: "Cooldown recovery failed to resume to BUILD_CONTEXT.",
          },
          nextSession: session,
        };
      }
      return {
        isBoundary: true,
        cycleResult: {
          status: "HUMAN_REVIEW_REQUIRED",
          sessionId,
          reason: "Cooldown recovery requires human review.",
        },
        nextSession: session,
      };
    }

    case "HUMAN_REVIEW": {
      return {
        isBoundary: true,
        cycleResult: {
          status: "HUMAN_REVIEW_REQUIRED",
          sessionId,
          reason: "Session requires human review before proceeding.",
        },
        nextSession: session,
      };
    }

    default: {
      const exhaustiveCheck: never = session.phase;
      throw new Error(`Unhandled phase: ${exhaustiveCheck}`);
    }
  }
}

/**
 * Execute the autonomous cognitive cycle until a stable boundary or max transitions.
 */
export async function runCognitiveCycleUntilBoundary(
  db: DatabaseClient,
  sessionId: string,
  ports: CognitiveCyclePorts,
  options: AdvanceCycleOptions & { readonly maxTransitions?: number },
): Promise<CognitiveCycleResult> {
  const maxTransitions = options.maxTransitions ?? 64;
  let transitions = 0;
  let currentAuth: AllowedExecutionSafetyState | undefined;

  while (transitions < maxTransitions) {
    transitions++;
    const stepResult = await advanceCognitiveCycle(
      db,
      sessionId,
      ports,
      options,
      currentAuth,
    );

    if (stepResult.runtimeAuthorization) {
      currentAuth = stepResult.runtimeAuthorization;
    }

    if (stepResult.isBoundary && stepResult.cycleResult) {
      return stepResult.cycleResult;
    }
  }

  throw PersistenceError.stateConflict(
    `Cognitive cycle exceeded max transition budget (${maxTransitions}) without reaching boundary.`,
    { sessionId, transitions },
  );
}

// Helpers
async function getRequiredCue(
  db: DatabaseClient,
  session: PersistedCognitiveSession,
): Promise<PersistedCueIngress> {
  if (!session.cueId) {
    throw PersistenceError.invalidPersistedState(
      `Session "${session.sessionId}" has no cueId.`,
    );
  }
  const cue = await cueRepository.findCueById(db, session.cueId);
  if (!cue) {
    throw PersistenceError.notFound(
      `Cue "${session.cueId}" for session "${session.sessionId}" not found.`,
    );
  }
  return cue;
}

async function getRequiredPlan(
  db: DatabaseClient,
  session: PersistedCognitiveSession,
): Promise<PersistedActionPlan> {
  if (!session.currentCandidateId) {
    throw PersistenceError.invalidPersistedState(
      `Session "${session.sessionId}" has no currentCandidateId.`,
    );
  }
  const plan = await planRepository.findPlanByCandidateId(
    db,
    session.currentCandidateId,
  );
  if (!plan) {
    throw PersistenceError.notFound(
      `Plan for candidate "${session.currentCandidateId}" not found.`,
    );
  }
  return plan;
}

async function getRequiredCandidate(
  db: DatabaseClient,
  session: PersistedCognitiveSession,
): Promise<PersistedCandidateAction> {
  if (!session.currentCandidateId) {
    throw PersistenceError.invalidPersistedState(
      `Session "${session.sessionId}" has no currentCandidateId.`,
    );
  }
  const candidate = await candidateRepository.findCandidateById(
    db,
    session.currentCandidateId,
  );
  if (!candidate) {
    throw PersistenceError.notFound(
      `Candidate "${session.currentCandidateId}" not found.`,
    );
  }
  return candidate;
}

async function transitionSessionPhase(
  db: DatabaseClient,
  session: PersistedCognitiveSession,
  nextPhase: CognitivePhase,
  updatedAt: string,
  extraUpdates: Partial<PersistedCognitiveSession> = {},
): Promise<PersistedCognitiveSession> {
  return await sessionRepository.transitionSession(db, {
    sessionId: session.sessionId,
    expectedRowVersion: session.rowVersion,
    nextSessionState: {
      phase: nextPhase,
      failureCount: extraUpdates.failureCount ?? session.failureCount,
      retryCount: extraUpdates.retryCount ?? session.retryCount,
      maxRetries: extraUpdates.maxRetries ?? session.maxRetries,
      cooldownUntil:
        extraUpdates.cooldownUntil !== undefined
          ? extraUpdates.cooldownUntil
          : nextPhase === "COOLDOWN"
            ? session.cooldownUntil
            : null,
      currentCandidateId:
        extraUpdates.currentCandidateId !== undefined
          ? extraUpdates.currentCandidateId
          : session.currentCandidateId,
      currentPlanId:
        extraUpdates.currentPlanId !== undefined
          ? extraUpdates.currentPlanId
          : session.currentPlanId,
      currentExecutionId:
        extraUpdates.currentExecutionId !== undefined
          ? extraUpdates.currentExecutionId
          : session.currentExecutionId,
      updatedAt,
    },
  });
}
