import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWED_GITHUB_REPO,
  GitHubReadOnlyAdapter,
} from "../../../adapters/github/github-adapter";
import { FakeStructuredAiProvider } from "../../../ai/testing/fake-ai-provider";
import {
  type PerceptionPort,
  type PlanBuilderPort,
  type PlanProposal,
} from "../../../orchestration/cognitive-ports";
import type {
  AssembledCognitiveContext,
  PerceptionResult,
} from "../../../orchestration/context-assembler";
import {
  type CognitiveCyclePorts,
} from "../../../orchestration/cognitive-loop-driver";
import { GeminiCandidateGeneratorPort } from "../../../orchestration/gemini-candidate-generator";
import {
  GitHubGroundingEvaluator,
  GitHubPolicyEvaluator,
} from "../../../orchestration/github-grounding-policy";
import { GitHubResultVerifier } from "../../../orchestration/github-result-verifier";
import { DefaultOperationRequestBuilder } from "../../../orchestration/operation-request-builder";
import type { PersistedCandidateAction } from "../../contracts/persisted-candidate-action";
import type { PersistedCueIngress } from "../../contracts/cue-ingress";
import type { PostgresDatabaseContext } from "../client";
import { executionRepository } from "../repositories/execution-repository";
import { learningRepository } from "../repositories/learning-repository";
import { observationRepository } from "../repositories/observation-repository";
import { rewardRepository } from "../repositories/reward-repository";
import { verificationRepository } from "../repositories/verification-repository";
import {
  cleanIntegrationTestTables,
  setupIntegrationTestDatabase,
} from "../testing/integration-harness";
import { ingestCue } from "../transactions/ingest-cue";
import { executeSessionCycle } from "../../../api/runtime-composition";

const T0 = "2026-08-31T05:00:00.000Z";

class MockPerception implements PerceptionPort {
  async perceive(cue: PersistedCueIngress): Promise<PerceptionResult> {
    return {
      summary: `Perceived task: ${cue.type}`,
      structuredFacts: {
        targetRepo: ALLOWED_GITHUB_REPO,
        requestedFile: "README.md",
      },
      perceivedAt: T0,
    };
  }
}

class MockPlanBuilder implements PlanBuilderPort {
  async buildPlan(
    candidate: PersistedCandidateAction,
    context: AssembledCognitiveContext,
  ): Promise<PlanProposal> {
    void context;
    return {
      planId: `plan:${candidate.candidateId}`,
      planGeneration: 1,
      steps: [
        {
          stepId: "step-read-1",
          ordinal: 0,
          description: `Execute read operation ${candidate.action} on ${ALLOWED_GITHUB_REPO}`,
        },
      ],
      dependencies: [],
    };
  }
}

describe("Milestone 8 — Server API & Control Plane Integration Tests (Live PostgreSQL)", () => {
  let context: PostgresDatabaseContext;

  beforeAll(async () => {
    context = await setupIntegrationTestDatabase();
  });

  beforeEach(async () => {
    await cleanIntegrationTestTables(context.db);
  });

  afterAll(async () => {
    if (context) {
      await context.close();
    }
  });

  function createMockFetch(responseInit: { status?: number; body?: unknown }) {
    return async () => {
      const status = responseInit.status ?? 200;
      const bodyText = JSON.stringify(responseInit.body ?? {});
      return new Response(bodyText, {
        status,
        headers: { "Content-Type": "application/json" },
      });
    };
  }

  it("completes a full autonomous cognitive cycle (CUE -> IDLE) and populates inspection stores", async () => {
    const { session } = await ingestCue(context.db, {
      cue: {
        cueId: "cue-m8-e2e-1",
        source: "postman",
        externalEventId: "evt-m8-e2e-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: { instruction: "Read README.md from repository" },
      },
      sessionId: "sess-m8-e2e-1",
      maxRetries: 2,
    });

    const fakeAi = new FakeStructuredAiProvider({
      fixedValue: {
        candidates: [
          {
            goal: "Read README.md from repository",
            action: "github.contents.read",
            confidence: 0.95,
            expectedUtility: 0.9,
            estimatedRisk: 0.1,
            estimatedCost: 0.05,
            reason: "Fulfill user request by reading README",
            evidenceIds: [],
          },
        ],
      },
    });

    const mockFetch = createMockFetch({
      status: 200,
      body: {
        name: "README.md",
        path: "README.md",
        sha: "abc1234567890",
        size: 120,
        encoding: "base64",
        content: Buffer.from(
          "# AutoDo AI Project\nAutonomous cognition.",
        ).toString("base64"),
      },
    });

    const ports: CognitiveCyclePorts = {
      perception: new MockPerception(),
      candidateGenerator: new GeminiCandidateGeneratorPort(fakeAi, {
        defaultRepository: ALLOWED_GITHUB_REPO,
      }),
      groundingEvaluator: new GitHubGroundingEvaluator(),
      policyEvaluator: new GitHubPolicyEvaluator(),
      planBuilder: new MockPlanBuilder(),
      requestBuilder: new DefaultOperationRequestBuilder(),
      adapter: new GitHubReadOnlyAdapter({
        token: "ghp_testValidToken123456789012345",
        fetchFn: mockFetch as typeof fetch,
      }),
      verifier: new GitHubResultVerifier(),
    };

    const cycleOutcome = await executeSessionCycle(
      context.db,
      session.sessionId,
      {
        taskProfile: "github-readonly-v1",
        ports,
        now: T0,
      },
    );

    // 1. Result verification
    expect(cycleOutcome.result.status).toBe("COMPLETED");
    expect(cycleOutcome.session.phase).toBe("IDLE");

    if (cycleOutcome.result.status === "COMPLETED") {
      const executionId = cycleOutcome.result.executionId;
      const verificationId = cycleOutcome.result.verificationId;

      // 2. Execution inspection
      const exec = await executionRepository.findExecutionById(
        context.db,
        executionId,
      );
      expect(exec).not.toBeNull();
      expect(["RUNNING", "SUCCEEDED"]).toContain(exec?.status);

      // 3. Observations inspection
      const obsList =
        await observationRepository.findManyObservationsByExecutionId(
          context.db,
          executionId,
        );
      expect(obsList.length).toBeGreaterThan(0);
      expect(obsList[0].source).toBe("provider-dispatch");

      // 4. Verification inspection
      const ver = await verificationRepository.findVerificationById(
        context.db,
        verificationId,
      );
      expect(ver).not.toBeNull();
      expect(ver?.status).toBe("VERIFIED");

      // 5. Rewards inspection
      const rewards = await rewardRepository.findRewardsByExecutionId(
        context.db,
        executionId,
      );
      expect(rewards.length).toBeGreaterThan(0);
      expect(rewards[0].signal).toBe("SUCCESS");
      expect(rewards[0].value).toBe(5.0);

      // 6. Learning state inspection
      const learning = await learningRepository.findLearningState(
        context.db,
        "github.readonly",
      );
      expect(learning).not.toBeNull();
      expect(learning?.sampleCount).toBe(1);
    }
  });

  it("M8.2 IDLE Rule: re-running an already completed IDLE session returns NO_ACTION without re-running cue", async () => {
    const { session } = await ingestCue(context.db, {
      cue: {
        cueId: "cue-m8-idle-1",
        source: "postman",
        externalEventId: "evt-m8-idle-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: { instruction: "Read README.md from repository" },
      },
      sessionId: "sess-m8-idle-1",
    });

    const fakeAi = new FakeStructuredAiProvider({
      fixedValue: {
        candidates: [
          {
            goal: "Read README.md from repository",
            action: "github.contents.read",
            confidence: 0.95,
            expectedUtility: 0.9,
            estimatedRisk: 0.1,
            estimatedCost: 0.05,
            reason: "Read README",
            evidenceIds: [],
          },
        ],
      },
    });

    const ports: CognitiveCyclePorts = {
      perception: new MockPerception(),
      candidateGenerator: new GeminiCandidateGeneratorPort(fakeAi),
      groundingEvaluator: new GitHubGroundingEvaluator(),
      policyEvaluator: new GitHubPolicyEvaluator(),
      planBuilder: new MockPlanBuilder(),
      requestBuilder: new DefaultOperationRequestBuilder(),
      adapter: new GitHubReadOnlyAdapter({
        token: "ghp_testToken123456789012345",
        fetchFn: createMockFetch({
          status: 200,
          body: { size: 50, encoding: "base64", content: "dGVzdA==" },
        }) as typeof fetch,
      }),
      verifier: new GitHubResultVerifier(),
    };

    // Run 1: completes cycle to IDLE
    const run1 = await executeSessionCycle(context.db, session.sessionId, {
      taskProfile: "github-readonly-v1",
      ports,
      now: T0,
    });
    expect(run1.result.status).toBe("COMPLETED");
    expect(run1.session.phase).toBe("IDLE");

    // Run 2: re-running already IDLE session returns NO_ACTION
    const run2 = await executeSessionCycle(context.db, session.sessionId, {
      taskProfile: "github-readonly-v1",
      ports,
      now: T0,
    });
    expect(run2.result.status).toBe("NO_ACTION");
    expect(run2.result.sessionId).toBe(session.sessionId);
    expect(run2.session.phase).toBe("IDLE");
  });

  it("CRITICAL SAFETY TEST: Policy DENY blocks execution even with maximum candidate score (AI IS NOT PERMISSION)", async () => {
    const { session } = await ingestCue(context.db, {
      cue: {
        cueId: "cue-m8-deny-1",
        source: "postman",
        externalEventId: "evt-m8-deny-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: { instruction: "Attempt unauthorized write to repository" },
      },
      sessionId: "sess-m8-deny-1",
    });

    let dispatchCalled = false;
    const fakeAi = new FakeStructuredAiProvider({
      fixedValue: {
        candidates: [
          {
            goal: "Write malicious content to main branch",
            action: "github.contents.read", // Disguised action with mutating goal
            confidence: 1.0,
            expectedUtility: 1.0,
            estimatedRisk: 0.0,
            estimatedCost: 0.0,
            reason: "Forced high confidence proposal",
            evidenceIds: [],
          },
        ],
      },
    });

    const ports: CognitiveCyclePorts = {
      perception: new MockPerception(),
      candidateGenerator: new GeminiCandidateGeneratorPort(fakeAi),
      groundingEvaluator: new GitHubGroundingEvaluator(), // Catches 'write' in goal -> CONTRADICTED
      policyEvaluator: new GitHubPolicyEvaluator(), // Catches non-VERIFIED grounding -> DENY
      planBuilder: new MockPlanBuilder(),
      requestBuilder: new DefaultOperationRequestBuilder(),
      adapter: new GitHubReadOnlyAdapter({
        token: "ghp_testToken123456789012345",
        fetchFn: (async () => {
          dispatchCalled = true;
          return new Response("{}", { status: 200 });
        }) as typeof fetch,
      }),
      verifier: new GitHubResultVerifier(),
    };

    const outcome = await executeSessionCycle(context.db, session.sessionId, {
      taskProfile: "github-readonly-v1",
      ports,
      now: T0,
    });

    expect(outcome.result.status).toBe("HUMAN_REVIEW_REQUIRED");
    expect(outcome.session.phase).toBe("HUMAN_REVIEW");
    expect(dispatchCalled).toBe(false); // 0 GitHub dispatch calls
  });

  it("handles zero candidates safely by returning NO_ACTION and returning session to IDLE", async () => {
    const { session } = await ingestCue(context.db, {
      cue: {
        cueId: "cue-m8-zero-cand",
        source: "postman",
        externalEventId: "evt-m8-zero-cand",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: { instruction: "Irrelevant task with no actionable steps" },
      },
      sessionId: "sess-m8-zero-cand",
    });

    const fakeAi = new FakeStructuredAiProvider({
      fixedValue: { candidates: [] },
    });

    const ports: CognitiveCyclePorts = {
      perception: new MockPerception(),
      candidateGenerator: new GeminiCandidateGeneratorPort(fakeAi),
      groundingEvaluator: new GitHubGroundingEvaluator(),
      policyEvaluator: new GitHubPolicyEvaluator(),
      planBuilder: new MockPlanBuilder(),
      requestBuilder: new DefaultOperationRequestBuilder(),
      adapter: new GitHubReadOnlyAdapter(),
      verifier: new GitHubResultVerifier(),
    };

    const outcome = await executeSessionCycle(context.db, session.sessionId, {
      taskProfile: "github-readonly-v1",
      ports,
      now: T0,
    });

    expect(outcome.result.status).toBe("NO_ACTION");
    expect(outcome.session.phase).toBe("IDLE");
  });
});
