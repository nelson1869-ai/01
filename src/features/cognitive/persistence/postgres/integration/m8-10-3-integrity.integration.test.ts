import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  cleanIntegrationTestTables,
  setupIntegrationTestDatabase,
} from "../testing/integration-harness";
import type { PostgresDatabaseContext } from "../client";
import { learningRepository } from "../repositories/learning-repository";
import { rewardRepository } from "../repositories/reward-repository";
import { memoryRepository } from "../repositories/memory-repository";
import { perceptionSnapshotRepository } from "../repositories/perception-snapshot-repository";
import { sessionRepository } from "../repositories/session-repository";
import { candidateRepository } from "../repositories/candidate-repository";
import { evidenceRepository } from "../repositories/evidence-repository";
import { planRepository } from "../repositories/plan-repository";
import { executionRepository } from "../repositories/execution-repository";
import { verificationRepository } from "../repositories/verification-repository";
import { ingestCue } from "../transactions/ingest-cue";
import {
  advanceCognitiveCycle,
  type CognitiveCyclePorts,
} from "../../../orchestration/cognitive-loop-driver";
import { GitHubResultVerifier } from "../../../orchestration/github-result-verifier";
import {
  GitHubGroundingEvaluator,
  GitHubPolicyEvaluator,
} from "../../../orchestration/github-grounding-policy";
import type { PerceptionResult } from "../../../orchestration/context-assembler";
import type {
  GeneratedCandidateAction,
  PlanProposal,
} from "../../../orchestration/cognitive-ports";
import type { PersistedCandidateAction } from "../../contracts/persisted-candidate-action";
import { admitVerifiedMemory } from "../../../orchestration/memory-orchestrator";
import { ALLOWED_GITHUB_REPO } from "../../../adapters/github/github-adapter";
import {
  allowAutonomousExecution,
  createInitialExecutionSafetyState,
} from "../../../domain/execution-safety";

describe("M8.10.3 End-to-End Cognitive Engine Integrity Integration Tests", () => {
  let context: PostgresDatabaseContext;
  const T0 = "2026-08-31T05:00:00.000Z";
  const T1 = "2026-08-31T05:00:01.000Z";

  beforeEach(async () => {
    context = await setupIntegrationTestDatabase();
    await cleanIntegrationTestTables(context.db);
  });

  afterAll(async () => {
    if (context) {
      await context.pool.end();
    }
  });

  async function seedExecutionAndVerification(
    sessionId: string,
    cueId: string,
    executionId: string,
    verificationId: string,
  ) {
    const candidateId = `cand:${sessionId}:gen1:1:seed`;
    const planId = `plan:${sessionId}:1`;

    await evidenceRepository.appendEvidence(context.db, {
      evidenceId: "obs-source-1",
      source: "verification",
      sourceId: "obs-1",
      claim: "Observation confirmed",
      observedAt: T0,
      createdAt: T0,
      providerMetadata: null,
    });

    await candidateRepository.appendCandidate(context.db, {
      candidateId,
      sessionId,
      cueId,
      evaluationGeneration: 1,
      goal: "Seed goal",
      action: "github.repo.get",
      confidence: 0.9,
      expectedUtility: 0.9,
      estimatedRisk: 0.1,
      estimatedCost: 0.1,
      scoreValue: 0.9,
      recommendation: "AUTO_CANDIDATE",
      scoreFormulaVersion: "v1",
      evidenceIds: [],
      createdAt: T0,
    });

    await planRepository.appendPlan(context.db, {
      planId,
      candidateId,
      planGeneration: 1,
      steps: [{ stepId: "step-1", ordinal: 0, description: "Step 1" }],
      dependencies: [],
      createdAt: T0,
    });

    await executionRepository.createPendingExecution(context.db, {
      executionId,
      sessionId,
      planId,
      status: "PENDING",
      currentStepId: null,
      startedAt: null,
      completedAt: null,
      error: null,
      safetyGenerationAtStart: null,
      rowVersion: 0,
      createdAt: T0,
      updatedAt: T0,
    });

    await verificationRepository.appendVerification(context.db, {
      verificationId,
      executionId,
      verificationGeneration: 1,
      observationSetDigest: `digest-${verificationId}`,
      verifierVersion: "v1",
      status: "VERIFIED",
      confidence: 1.0,
      reason: "Verified execution",
      verifiedAt: T0,
    });
  }

  describe("1. Rebuild Equivalence Property Test", () => {
    it("rebuilds learning state independently per skillKey without cross-contamination", async () => {
      const sessionId = "sess-rebuild-1";
      const cueId = "cue-rebuild-1";

      await ingestCue(context.db, {
        cue: {
          cueId,
          source: "github",
          externalEventId: "ev-rebuild-1",
          type: "github.issue.created",
          occurredAt: T0,
          receivedAt: T0,
          payload: { repo: ALLOWED_GITHUB_REPO },
        },
        sessionId,
      });

      await seedExecutionAndVerification(
        sessionId,
        cueId,
        "exec-rebuild-a1",
        "ver-rebuild-a1",
      );
      await seedExecutionAndVerification(
        sessionId,
        cueId,
        "exec-rebuild-a2",
        "ver-rebuild-a2",
      );
      await seedExecutionAndVerification(
        sessionId,
        cueId,
        "exec-rebuild-b1",
        "ver-rebuild-b1",
      );
      await seedExecutionAndVerification(
        sessionId,
        cueId,
        "exec-rebuild-b2",
        "ver-rebuild-b2",
      );

      // Insert reward events for Skill A ("github.repo.get")
      await rewardRepository.appendReward(context.db, {
        rewardEventId: "rew-skill-a-1",
        rewardIdempotencyKey: "idemp-rew-a1",
        executionId: "exec-rebuild-a1",
        verificationId: "ver-rebuild-a1",
        rewardRuleId: "rule-success",
        signal: "SUCCESS",
        value: 5,
        skillKey: "github.repo.get",
        reason: "Repo get verified",
        createdAt: T0,
      });

      await rewardRepository.appendReward(context.db, {
        rewardEventId: "rew-skill-a-2",
        rewardIdempotencyKey: "idemp-rew-a2",
        executionId: "exec-rebuild-a2",
        verificationId: "ver-rebuild-a2",
        rewardRuleId: "rule-failure",
        signal: "FAILURE",
        value: -10,
        skillKey: "github.repo.get",
        reason: "Repo get failed",
        createdAt: T1,
      });

      // Insert reward events for Skill B ("github.issues.list")
      await rewardRepository.appendReward(context.db, {
        rewardEventId: "rew-skill-b-1",
        rewardIdempotencyKey: "idemp-rew-b1",
        executionId: "exec-rebuild-b1",
        verificationId: "ver-rebuild-b1",
        rewardRuleId: "rule-success",
        signal: "SUCCESS",
        value: 5,
        skillKey: "github.issues.list",
        reason: "Issues list verified",
        createdAt: T0,
      });

      await rewardRepository.appendReward(context.db, {
        rewardEventId: "rew-skill-b-2",
        rewardIdempotencyKey: "idemp-rew-b2",
        executionId: "exec-rebuild-b2",
        verificationId: "ver-rebuild-b2",
        rewardRuleId: "rule-success",
        signal: "SUCCESS",
        value: 5,
        skillKey: "github.issues.list",
        reason: "Issues list verified again",
        createdAt: T1,
      });

      // Rebuild Skill A
      const stateA = await learningRepository.rebuildLearningStateFromRewards(
        context.db,
        "github.repo.get",
        T1,
      );
      expect(stateA.skillKey).toBe("github.repo.get");
      expect(stateA.sampleCount).toBe(2);
      expect(stateA.totalReward).toBe(-5); // 5 + (-10)

      // Rebuild Skill B
      const stateB = await learningRepository.rebuildLearningStateFromRewards(
        context.db,
        "github.issues.list",
        T1,
      );
      expect(stateB.skillKey).toBe("github.issues.list");
      expect(stateB.sampleCount).toBe(2);
      expect(stateB.totalReward).toBe(10); // 5 + 5

      // Idempotency: Rebuilding again yields identical state
      const stateA2 = await learningRepository.rebuildLearningStateFromRewards(
        context.db,
        "github.repo.get",
        T1,
      );
      expect(stateA2.totalReward).toBe(stateA.totalReward);
      expect(stateA2.confidence).toBe(stateA.confidence);
      expect(stateA2.sampleCount).toBe(stateA.sampleCount);
    });
  });

  describe("2. Authoritative Perception Snapshot Durability and Reuse", () => {
    it("computes perception snapshot once in PERCEIVE and reuses it in subsequent phases", async () => {
      const sessionId = "sess-snap-1";
      const cueId = "cue-snap-1";

      await ingestCue(context.db, {
        cue: {
          cueId,
          source: "github",
          externalEventId: "ev-snap-1",
          type: "github.issue.created",
          occurredAt: T0,
          receivedAt: T0,
          payload: { prompt: "Read repository metadata" },
        },
        sessionId,
      });

      let perceiveCallCount = 0;
      const ports: CognitiveCyclePorts = {
        perception: {
          async perceive(): Promise<PerceptionResult> {
            perceiveCallCount++;
            return {
              summary: "Authoritative perception for repo get",
              structuredFacts: {
                action: "github.repo.get",
                target: ALLOWED_GITHUB_REPO,
              },
              perceivedAt: T0,
            };
          },
        },
        candidateGenerator: {
          async generateCandidates(): Promise<
            readonly GeneratedCandidateAction[]
          > {
            return [];
          },
        },
        groundingEvaluator: new GitHubGroundingEvaluator(),
        policyEvaluator: new GitHubPolicyEvaluator(),
        planBuilder: {
          async buildPlan(): Promise<PlanProposal> {
            return {
              planId: "plan-1",
              planGeneration: 1,
              steps: [
                { stepId: "step-1", ordinal: 0, description: "Read repo" },
              ],
              dependencies: [],
            };
          },
        },
        verifier: new GitHubResultVerifier(),
        adapter: {
          scope: "github-rest",
          idempotencySupport: "NONE",
          supportsReconciliation: false,
          dispatch: async () => ({
            outcome: "CONFIRMED_SUCCESS",
            providerOperationId: "op-1",
            result: { name: "01", full_name: ALLOWED_GITHUB_REPO },
            finishedAt: T0,
          }),
        },
      };

      // 1. Advance from CUE -> PERCEIVE
      const step1 = await advanceCognitiveCycle(context.db, sessionId, ports, {
        skillKey: "github.repo.get",
        now: T0,
      });
      expect(step1.nextSession.phase).toBe("PERCEIVE");

      // 2. Advance from PERCEIVE -> BUILD_CONTEXT (creates snapshot)
      const step2 = await advanceCognitiveCycle(context.db, sessionId, ports, {
        skillKey: "github.repo.get",
        now: T0,
      });
      expect(step2.nextSession.phase).toBe("BUILD_CONTEXT");
      expect(perceiveCallCount).toBe(1);

      // Verify snapshot was persisted in DB
      const snapshot =
        await perceptionSnapshotRepository.findBySessionAndGeneration(
          context.db,
          sessionId,
          1,
        );
      expect(snapshot).not.toBeNull();
      expect(snapshot?.summary).toBe("Authoritative perception for repo get");

      // 3. Advance from BUILD_CONTEXT -> RETRIEVE_MEMORY (reuses snapshot, does NOT call perceive)
      const step3 = await advanceCognitiveCycle(context.db, sessionId, ports, {
        skillKey: "github.repo.get",
        now: T0,
      });
      expect(step3.nextSession.phase).toBe("RETRIEVE_MEMORY");
      expect(perceiveCallCount).toBe(1); // Call count remains 1!

      // 4. Advance from RETRIEVE_MEMORY -> GENERATE_CANDIDATES (reuses snapshot)
      const step4 = await advanceCognitiveCycle(context.db, sessionId, ports, {
        skillKey: "github.repo.get",
        now: T0,
      });
      expect(step4.nextSession.phase).toBe("GENERATE_CANDIDATES");
      expect(perceiveCallCount).toBe(1); // Call count remains 1!
    });
  });

  describe("3. Multi-Step Action Plan Rejection Boundary", () => {
    it("rejects multi-step plan before execution preparation without dispatching operations", async () => {
      const sessionId = "sess-multistep-1";
      const cueId = "cue-multistep-1";

      await ingestCue(context.db, {
        cue: {
          cueId,
          source: "github",
          externalEventId: "ev-multi-1",
          type: "github.issue.created",
          occurredAt: T0,
          receivedAt: T0,
          payload: { prompt: "Read repository metadata" },
        },
        sessionId,
      });

      // Transition session directly to PLAN with valid candidate, grounding, policy
      const candidate: PersistedCandidateAction = {
        candidateId: `cand:${sessionId}:gen1:1:fingerprint`,
        sessionId,
        cueId,
        evaluationGeneration: 1,
        goal: "Read repository metadata",
        action: "github.repo.get",
        confidence: 0.95,
        expectedUtility: 0.9,
        estimatedRisk: 0.05,
        estimatedCost: 0.05,
        scoreValue: 0.9,
        recommendation: "AUTO_CANDIDATE",
        scoreFormulaVersion: "v1",
        evidenceIds: [],
        createdAt: T0,
      };
      await candidateRepository.appendCandidate(context.db, candidate);

      await sessionRepository.transitionSession(context.db, {
        sessionId,
        expectedRowVersion: 0,
        nextSessionState: {
          phase: "PLAN",
          failureCount: 0,
          retryCount: 0,
          maxRetries: 3,
          evaluationGeneration: 1,
          cooldownUntil: null,
          currentCandidateId: candidate.candidateId,
          currentPlanId: null,
          currentExecutionId: null,
          updatedAt: T0,
        },
      });

      // Save perception snapshot
      await perceptionSnapshotRepository.saveSnapshot(context.db, {
        snapshotId: `psnap:${sessionId}:gen1`,
        sessionId,
        cueId,
        evaluationGeneration: 1,
        summary: "Perception for multi-step test",
        structuredFacts: { action: "github.repo.get" },
        targetSpec: {
          kind: "REPOSITORY",
          repository: ALLOWED_GITHUB_REPO,
          owner: "nelson1869-ai",
          repo: "01",
        },
        perceivedAt: T0,
        createdAt: T0,
      });

      let dispatchCount = 0;
      const ports: CognitiveCyclePorts = {
        perception: {
          async perceive(): Promise<PerceptionResult> {
            return { summary: "test", structuredFacts: {}, perceivedAt: T0 };
          },
        },
        candidateGenerator: {
          async generateCandidates() {
            return [];
          },
        },
        groundingEvaluator: new GitHubGroundingEvaluator(),
        policyEvaluator: new GitHubPolicyEvaluator(),
        planBuilder: {
          async buildPlan(): Promise<PlanProposal> {
            // Returns invalid multi-step plan
            return {
              planId: "plan-multi-2steps",
              planGeneration: 1,
              steps: [
                {
                  stepId: "step-1",
                  ordinal: 0,
                  description: "Step 1: Read metadata",
                },
                {
                  stepId: "step-2",
                  ordinal: 1,
                  description: "Step 2: Read contents",
                },
              ],
              dependencies: [{ stepId: "step-2", dependsOnStepId: "step-1" }],
            };
          },
        },
        verifier: new GitHubResultVerifier(),
        adapter: {
          scope: "github-rest",
          idempotencySupport: "NONE",
          supportsReconciliation: false,
          dispatch: async () => {
            dispatchCount++;
            return {
              outcome: "CONFIRMED_SUCCESS",
              providerOperationId: "op-2",
              result: {},
              finishedAt: T0,
            };
          },
        },
      };

      // Advance from PLAN with mock runtime authorization
      const auth = allowAutonomousExecution(
        createInitialExecutionSafetyState(),
        { phase: "POLICY_SAFETY" },
        { candidateId: candidate.candidateId, status: "VERIFIED" },
        { candidateId: candidate.candidateId, outcome: "ALLOW" },
      );

      await expect(
        advanceCognitiveCycle(
          context.db,
          sessionId,
          ports,
          {
            skillKey: "github.repo.get",
            now: T0,
          },
          auth,
        ),
      ).rejects.toMatchObject({
        code: "INVALID_PERSISTED_STATE",
      });

      expect(dispatchCount).toBe(0);
    });
  });

  describe("4. Durable Memory Accounting", () => {
    it("accurately counts memories admitted for a verification", async () => {
      const sessionId = "sess-mem-1";
      const cueId = "cue-mem-1";
      const executionId = "exec-mem-1";
      const verificationId = "ver-exec-mem-1";

      await ingestCue(context.db, {
        cue: {
          cueId,
          source: "github",
          externalEventId: "ev-mem-1",
          type: "github.issue.created",
          occurredAt: T0,
          receivedAt: T0,
          payload: {},
        },
        sessionId,
      });

      await seedExecutionAndVerification(
        sessionId,
        cueId,
        executionId,
        verificationId,
      );

      // 0 admitted memories initially
      const count0 = await memoryRepository.countAdmittedMemoriesByVerification(
        context.db,
        verificationId,
      );
      expect(count0).toBe(0);

      // Admit verified memory 1
      await admitVerifiedMemory(context.db, {
        commandIdempotencyKey: "mem-cmd-1",
        memoryId: "mem-1",
        executionId,
        verificationId,
        kind: "FACT",
        key: "repo.name",
        version: 1,
        content: { name: "01" },
        sourceIds: ["obs-source-1"],
        confidence: 0.95,
        admissionRuleVersion: "v1",
        verifiedAt: T0,
        createdAt: T0,
      });

      const count1 = await memoryRepository.countAdmittedMemoriesByVerification(
        context.db,
        verificationId,
      );
      expect(count1).toBe(1);

      // Admit verified memory 2
      await admitVerifiedMemory(context.db, {
        commandIdempotencyKey: "mem-cmd-2",
        memoryId: "mem-2",
        executionId,
        verificationId,
        kind: "FACT",
        key: "repo.full_name",
        version: 1,
        content: { full_name: ALLOWED_GITHUB_REPO },
        sourceIds: ["obs-source-1"],
        confidence: 0.95,
        admissionRuleVersion: "v1",
        verifiedAt: T0,
        createdAt: T0,
      });

      const count2 = await memoryRepository.countAdmittedMemoriesByVerification(
        context.db,
        verificationId,
      );
      expect(count2).toBe(2);
    });
  });
});
