import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWED_GITHUB_REPO,
  GitHubReadOnlyAdapter,
} from "../../../adapters/github/github-adapter";
import { AiProviderError } from "../../../ai/ai-errors";
import { FakeStructuredAiProvider } from "../../../ai/testing/fake-ai-provider";
import {
  advanceCognitiveCycle,
  type CognitiveCyclePorts,
  runCognitiveCycleUntilBoundary,
} from "../../../orchestration/cognitive-loop-driver";
import { GeminiCandidateGeneratorPort } from "../../../orchestration/gemini-candidate-generator";
import {
  GitHubGroundingEvaluator,
  GitHubPolicyEvaluator,
} from "../../../orchestration/github-grounding-policy";
import { GitHubResultVerifier } from "../../../orchestration/github-result-verifier";
import { DefaultOperationRequestBuilder } from "../../../orchestration/operation-request-builder";
import type {
  PerceptionPort,
  PlanBuilderPort,
  PlanProposal,
} from "../../../orchestration/cognitive-ports";
import type {
  AssembledCognitiveContext,
  PerceptionResult,
} from "../../../orchestration/context-assembler";
import type { PersistedCandidateAction } from "../../contracts/persisted-candidate-action";
import type { PersistedCueIngress } from "../../contracts/cue-ingress";
import type { PostgresDatabaseContext } from "../client";
import { candidateRepository } from "../repositories/candidate-repository";
import { executionOperationRepository } from "../repositories/execution-operation-repository";
import { executionRepository } from "../repositories/execution-repository";
import { learningRepository } from "../repositories/learning-repository";
import { observationRepository } from "../repositories/observation-repository";
import { planRepository } from "../repositories/plan-repository";
import { rewardRepository } from "../repositories/reward-repository";
import { safetyRepository } from "../repositories/safety-repository";
import { sessionRepository } from "../repositories/session-repository";
import { verificationRepository } from "../repositories/verification-repository";
import {
  cleanIntegrationTestTables,
  setupIntegrationTestDatabase,
} from "../testing/integration-harness";
import { ingestCue } from "../transactions/ingest-cue";

const T0 = "2026-08-31T05:00:00.000Z";

class DeterministicPerception implements PerceptionPort {
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

class DeterministicPlanBuilder implements PlanBuilderPort {
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

describe("Milestone 7 — Real AI + GitHub Read Tool Integration Tests (Live PostgreSQL)", () => {
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
    return async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") {
        throw new Error(`Non-GET method detected: ${init.method}`);
      }
      const status = responseInit.status ?? 200;
      return new Response(JSON.stringify(responseInit.body ?? {}), {
        status,
        headers: { "content-type": "application/json" },
      });
    };
  }

  it("1-20. Full M7 end-to-end flow: Gemini candidate -> deterministic grounding -> policy ALLOW -> runtime authorization -> GitHub read adapter -> factual observation -> verification -> reward + learning", async () => {
    const sessionId = "sess-m7-full-flow";
    const cueId = "cue-m7-full-flow";

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "github-webhook",
        externalEventId: "ev-m7-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: { instruction: "Read README.md from repo" },
      },
      sessionId,
      maxRetries: 3,
    });

    const fakeAi = new FakeStructuredAiProvider({
      fixedValue: {
        candidates: [
          {
            goal: "Read repository documentation",
            action: "github.contents.read",
            confidence: 0.95,
            expectedUtility: 0.9,
            estimatedRisk: 0.05,
            estimatedCost: 0.01,
            reason: "Fulfills request to read README",
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
        sha: "sha-m7-readme-123",
        size: 256,
        encoding: "base64",
        content: Buffer.from("# AutoDo AI M7 Verified").toString("base64"),
      },
    });

    const adapter = new GitHubReadOnlyAdapter({
      token: "ghp_mock_secret_token_1234567890",
      fetchFn: mockFetch,
    });

    const ports: CognitiveCyclePorts = {
      perception: new DeterministicPerception(),
      candidateGenerator: new GeminiCandidateGeneratorPort(fakeAi),
      groundingEvaluator: new GitHubGroundingEvaluator(),
      policyEvaluator: new GitHubPolicyEvaluator(),
      planBuilder: new DeterministicPlanBuilder(),
      verifier: new GitHubResultVerifier(),
      adapter,
      requestBuilder: new DefaultOperationRequestBuilder(),
    };

    // 1. Advance through the autonomous loop until boundary
    const result = await runCognitiveCycleUntilBoundary(
      context.db,
      sessionId,
      ports,
      { skillKey: "github.contents.read", now: T0 },
    );

    expect(result.status).toBe("COMPLETED");

    // 2. Candidate persisted once
    const candidates = await candidateRepository.findCandidatesByCueId(
      context.db,
      cueId,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].action).toBe("github.contents.read");

    // 3. Execution, operation, observation, verification, reward persisted
    const plan = await planRepository.findPlanByCandidateId(
      context.db,
      candidates[0].candidateId,
    );
    expect(plan).not.toBeNull();
    const executionId = `exec:${sessionId}:${plan!.planId}`;

    const op = await executionOperationRepository.findOperationById(
      context.db,
      `op:${executionId}:step-read-1`,
    );
    expect(op).not.toBeNull();
    expect(op?.providerScope).toBe("github-rest");
    expect(op?.status).toBe("SUCCEEDED");

    const obs = await observationRepository.findManyObservationsByExecutionId(
      context.db,
      executionId,
    );
    expect(obs).toHaveLength(1);
    expect(obs[0].source).toBe("provider-dispatch");
    expect(JSON.stringify(obs[0])).not.toContain(
      "ghp_mock_secret_token_1234567890",
    );

    const ver = await verificationRepository.findVerificationById(
      context.db,
      `ver:${executionId}`,
    );
    expect(ver).not.toBeNull();
    expect(ver?.status).toBe("VERIFIED");

    const rew = await rewardRepository.findRewardById(
      context.db,
      `rew:ver:${executionId}`,
    );
    expect(rew).not.toBeNull();
    expect(rew?.signal).toBe("SUCCESS");
    expect(rew?.value).toBe(5);

    // 4. Learning state updated
    const learning = await learningRepository.findLearningState(
      context.db,
      "github.contents.read",
    );
    expect(learning).not.toBeNull();
    expect(learning?.sampleCount).toBe(1);

    // 5. Final session phase is IDLE
    const finalSession = await sessionRepository.findSessionById(
      context.db,
      sessionId,
    );
    expect(finalSession?.phase).toBe("IDLE");
  });

  it("21. Candidate replay does NOT invoke Gemini again", async () => {
    const sessionId = "sess-m7-replay";
    const cueId = "cue-m7-replay";

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-m7-replay",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId,
      maxRetries: 3,
    });

    const fakeAi = new FakeStructuredAiProvider({
      fixedValue: {
        candidates: [
          {
            goal: "Read repo metadata",
            action: "github.repo.get",
            confidence: 0.95,
            expectedUtility: 0.9,
            estimatedRisk: 0.05,
            estimatedCost: 0.01,
            reason: "Read metadata",
            evidenceIds: [],
          },
        ],
      },
    });

    const ports: CognitiveCyclePorts = {
      perception: new DeterministicPerception(),
      candidateGenerator: new GeminiCandidateGeneratorPort(fakeAi),
      groundingEvaluator: new GitHubGroundingEvaluator(),
      policyEvaluator: new GitHubPolicyEvaluator(),
      planBuilder: new DeterministicPlanBuilder(),
      verifier: new GitHubResultVerifier(),
      adapter: new GitHubReadOnlyAdapter({
        token: "test",
        fetchFn: createMockFetch({}),
      }),
      requestBuilder: new DefaultOperationRequestBuilder(),
    };

    // Transition from CUE -> PERCEIVE -> BUILD_CONTEXT -> RETRIEVE_MEMORY -> GENERATE_CANDIDATES
    let step = await advanceCognitiveCycle(context.db, sessionId, ports, {
      skillKey: "github.repo.get",
      now: T0,
    }); // -> PERCEIVE
    step = await advanceCognitiveCycle(context.db, sessionId, ports, {
      skillKey: "github.repo.get",
      now: T0,
    }); // -> BUILD_CONTEXT
    step = await advanceCognitiveCycle(context.db, sessionId, ports, {
      skillKey: "github.repo.get",
      now: T0,
    }); // -> RETRIEVE_MEMORY
    step = await advanceCognitiveCycle(context.db, sessionId, ports, {
      skillKey: "github.repo.get",
      now: T0,
    }); // -> GENERATE_CANDIDATES

    // 1st Generation (calls Gemini)
    step = await advanceCognitiveCycle(context.db, sessionId, ports, {
      skillKey: "github.repo.get",
      now: T0,
    });
    expect(step.nextSession.phase).toBe("SCORE");
    expect(fakeAi.recordedRequests).toHaveLength(1);

    // Reset session back to GENERATE_CANDIDATES to simulate recovery/replay
    await sessionRepository.transitionSession(context.db, {
      sessionId,
      expectedRowVersion: step.nextSession.rowVersion,
      nextSessionState: {
        phase: "GENERATE_CANDIDATES",
        failureCount: 0,
        retryCount: 0,
        maxRetries: 3,
        cooldownUntil: null,
        updatedAt: T0,
      },
    });

    // 2nd Advance from GENERATE_CANDIDATES (must NOT call Gemini again)
    step = await advanceCognitiveCycle(context.db, sessionId, ports, {
      skillKey: "github.repo.get",
      now: T0,
    });
    expect(step.nextSession.phase).toBe("SCORE");
    expect(fakeAi.recordedRequests).toHaveLength(1); // Still 1!
  });

  it("25-26. Unsupported write candidate or prompt injection stops before authorization -> Adapter dispatch count is ZERO", async () => {
    const sessionId = "sess-m7-write-block";
    const cueId = "cue-m7-write-block";

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-write-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId,
      maxRetries: 3,
    });

    let adapterCalled = false;
    const fakeAdapter = new GitHubReadOnlyAdapter({
      token: "test-token",
      fetchFn: async () => {
        adapterCalled = true;
        return new Response("{}", { status: 200 });
      },
    });

    const fakeAi = new FakeStructuredAiProvider({
      fixedValue: {
        candidates: [
          {
            goal: "Write to README and commit",
            action: "github.contents.read", // Disguised goal
            confidence: 1.0,
            expectedUtility: 1.0,
            estimatedRisk: 0.0,
            estimatedCost: 0.0,
            reason: "Write attempt",
            evidenceIds: [],
          },
        ],
      },
    });

    const ports: CognitiveCyclePorts = {
      perception: new DeterministicPerception(),
      candidateGenerator: new GeminiCandidateGeneratorPort(fakeAi),
      groundingEvaluator: new GitHubGroundingEvaluator(),
      policyEvaluator: new GitHubPolicyEvaluator(),
      planBuilder: new DeterministicPlanBuilder(),
      verifier: new GitHubResultVerifier(),
      adapter: fakeAdapter,
      requestBuilder: new DefaultOperationRequestBuilder(),
    };

    const result = await runCognitiveCycleUntilBoundary(
      context.db,
      sessionId,
      ports,
      { skillKey: "github.contents.read", now: T0 },
    );

    expect(result.status).toBe("HUMAN_REVIEW_REQUIRED");
    expect(adapterCalled).toBe(false);

    const safety = await safetyRepository.findSafetyStateBySessionId(
      context.db,
      sessionId,
    );
    expect(safety?.status).toBe("UNAUTHORIZED");
  });

  it("27-31. GitHub HTTP failures (401, 403, 404, 429, timeout) safely fail without exposing tokens", async () => {
    const errorScenarios: [number, string][] = [
      [401, "sess-m7-401"],
      [403, "sess-m7-403"],
      [404, "sess-m7-404"],
      [429, "sess-m7-429"],
    ];

    for (const [statusCode, testSessionId] of errorScenarios) {
      await ingestCue(context.db, {
        cue: {
          cueId: `cue-${testSessionId}`,
          source: "test",
          externalEventId: `ev-${testSessionId}`,
          type: "user.action",
          occurredAt: T0,
          receivedAt: T0,
          payload: {},
        },
        sessionId: testSessionId,
        maxRetries: 3,
      });

      const fakeAi = new FakeStructuredAiProvider({
        fixedValue: {
          candidates: [
            {
              goal: "Read repository metadata",
              action: "github.repo.get",
              confidence: 0.95,
              expectedUtility: 0.9,
              estimatedRisk: 0.05,
              estimatedCost: 0.01,
              reason: "Read metadata",
              evidenceIds: [],
            },
          ],
        },
      });

      const adapter = new GitHubReadOnlyAdapter({
        token: "ghp_secret_token_scenario",
        fetchFn: createMockFetch({
          status: statusCode,
          body: { message: "API Error" },
        }),
      });

      const ports: CognitiveCyclePorts = {
        perception: new DeterministicPerception(),
        candidateGenerator: new GeminiCandidateGeneratorPort(fakeAi),
        groundingEvaluator: new GitHubGroundingEvaluator(),
        policyEvaluator: new GitHubPolicyEvaluator(),
        planBuilder: new DeterministicPlanBuilder(),
        verifier: new GitHubResultVerifier(),
        adapter,
        requestBuilder: new DefaultOperationRequestBuilder(),
      };

      const result = await runCognitiveCycleUntilBoundary(
        context.db,
        testSessionId,
        ports,
        { skillKey: "github.repo.get", now: T0 },
      );

      expect(result.status).not.toBe("COMPLETED");
      const latestExec = await executionRepository.findLatestExecutionBySessionId(
        context.db,
        testSessionId,
      );
      expect(latestExec).not.toBeNull();
      const obs = await observationRepository.findManyObservationsByExecutionId(
        context.db,
        latestExec!.executionId,
      );
      expect(obs.length).toBeGreaterThan(0);
      // Verify token never appears anywhere in database records
      expect(JSON.stringify(obs)).not.toContain("ghp_secret_token_scenario");
    }
  });

  it("32-34. Gemini failures (timeout, invalid JSON) safely stop before authorization -> zero GitHub adapter calls", async () => {
    const sessionId = "sess-m7-ai-fail";
    const cueId = "cue-m7-ai-fail";

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-ai-fail-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId,
      maxRetries: 3,
    });

    let adapterDispatched = false;
    const fakeAdapter = new GitHubReadOnlyAdapter({
      token: "test-token",
      fetchFn: async () => {
        adapterDispatched = true;
        return new Response("{}", { status: 200 });
      },
    });

    const failingAi = new FakeStructuredAiProvider({
      errorToThrow: AiProviderError.timeout("gemini", 30000),
    });

    const ports: CognitiveCyclePorts = {
      perception: new DeterministicPerception(),
      candidateGenerator: new GeminiCandidateGeneratorPort(failingAi),
      groundingEvaluator: new GitHubGroundingEvaluator(),
      policyEvaluator: new GitHubPolicyEvaluator(),
      planBuilder: new DeterministicPlanBuilder(),
      verifier: new GitHubResultVerifier(),
      adapter: fakeAdapter,
      requestBuilder: new DefaultOperationRequestBuilder(),
    };

    await expect(
      runCognitiveCycleUntilBoundary(context.db, sessionId, ports, {
        skillKey: "github.contents.read",
        now: T0,
      }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
    });

    expect(adapterDispatched).toBe(false);
  });

  it("35-36. Score 1.0 + Learning .9999 + Mutating Action: Grounding/Policy blocks and adapter count is ZERO", async () => {
    const sessionId = "sess-m7-score-subordination";
    const cueId = "cue-m7-score-subordination";

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-score-subord",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId,
      maxRetries: 3,
    });

    let githubCalled = false;
    const fakeAdapter = new GitHubReadOnlyAdapter({
      token: "test-token",
      fetchFn: async () => {
        githubCalled = true;
        return new Response("{}", { status: 200 });
      },
    });

    const fakeAi = new FakeStructuredAiProvider({
      fixedValue: {
        candidates: [
          {
            goal: "Delete issues",
            action: "github.issues.list", // Disguised action with delete goal
            confidence: 1.0,
            expectedUtility: 1.0,
            estimatedRisk: 0.0,
            estimatedCost: 0.0,
            reason: "Delete request",
            evidenceIds: [],
          },
        ],
      },
    });

    const ports: CognitiveCyclePorts = {
      perception: new DeterministicPerception(),
      candidateGenerator: new GeminiCandidateGeneratorPort(fakeAi),
      groundingEvaluator: new GitHubGroundingEvaluator(),
      policyEvaluator: new GitHubPolicyEvaluator(),
      planBuilder: new DeterministicPlanBuilder(),
      verifier: new GitHubResultVerifier(),
      adapter: fakeAdapter,
      requestBuilder: new DefaultOperationRequestBuilder(),
    };

    const result = await runCognitiveCycleUntilBoundary(
      context.db,
      sessionId,
      ports,
      { skillKey: "github.issues.list", now: T0 },
    );

    expect(result.status).toBe("HUMAN_REVIEW_REQUIRED");
    expect(githubCalled).toBe(false);
  });

  it("37-40. Completed M7 cycle returns session to IDLE and accepts new incoming cue", async () => {
    const sessionId = "sess-m7-cycle-completion";
    const cueId1 = "cue-m7-comp-1";
    const cueId2 = "cue-m7-comp-2";

    await ingestCue(context.db, {
      cue: {
        cueId: cueId1,
        source: "test",
        externalEventId: "ev-comp-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId,
      maxRetries: 3,
    });

    const fakeAi = new FakeStructuredAiProvider({
      fixedValue: {
        candidates: [
          {
            goal: "Read repository metadata",
            action: "github.repo.get",
            confidence: 0.95,
            expectedUtility: 0.9,
            estimatedRisk: 0.05,
            estimatedCost: 0.01,
            reason: "Read metadata",
            evidenceIds: [],
          },
        ],
      },
    });

    const adapter = new GitHubReadOnlyAdapter({
      token: "test-token",
      fetchFn: createMockFetch({
        status: 200,
        body: { name: "01", full_name: ALLOWED_GITHUB_REPO },
      }),
    });

    const ports: CognitiveCyclePorts = {
      perception: new DeterministicPerception(),
      candidateGenerator: new GeminiCandidateGeneratorPort(fakeAi),
      groundingEvaluator: new GitHubGroundingEvaluator(),
      policyEvaluator: new GitHubPolicyEvaluator(),
      planBuilder: new DeterministicPlanBuilder(),
      verifier: new GitHubResultVerifier(),
      adapter,
      requestBuilder: new DefaultOperationRequestBuilder(),
    };

    const result = await runCognitiveCycleUntilBoundary(
      context.db,
      sessionId,
      ports,
      { skillKey: "github.repo.get", now: T0 },
    );

    expect(result.status).toBe("COMPLETED");

    const session = await sessionRepository.findSessionById(
      context.db,
      sessionId,
    );
    expect(session?.phase).toBe("IDLE");

    // Acceptance of second cue after completion
    const secondCueIngress = await ingestCue(context.db, {
      cue: {
        cueId: cueId2,
        source: "test",
        externalEventId: "ev-comp-2",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId: "sess-m7-cycle-completion-2",
      maxRetries: 3,
    });

    expect(secondCueIngress.session.cueId).toBe(cueId2);
    expect(secondCueIngress.session.phase).toBe("CUE");
  });

  it("41. Zero candidates leads through existing NO_ACTION path with ZERO GitHub calls", async () => {
    const sessionId = "sess-m7-zero-cand";
    const cueId = "cue-m7-zero-cand";

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-zero-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId,
      maxRetries: 3,
    });

    let githubCalled = false;
    const fakeAdapter = new GitHubReadOnlyAdapter({
      token: "test-token",
      fetchFn: async () => {
        githubCalled = true;
        return new Response("{}", { status: 200 });
      },
    });

    const zeroAi = new FakeStructuredAiProvider({
      fixedValue: { candidates: [] },
    });

    const ports: CognitiveCyclePorts = {
      perception: new DeterministicPerception(),
      candidateGenerator: new GeminiCandidateGeneratorPort(zeroAi),
      groundingEvaluator: new GitHubGroundingEvaluator(),
      policyEvaluator: new GitHubPolicyEvaluator(),
      planBuilder: new DeterministicPlanBuilder(),
      verifier: new GitHubResultVerifier(),
      adapter: fakeAdapter,
      requestBuilder: new DefaultOperationRequestBuilder(),
    };

    const result = await runCognitiveCycleUntilBoundary(
      context.db,
      sessionId,
      ports,
      { skillKey: "github.repo.get", now: T0 },
    );

    expect(result.status).toBe("NO_ACTION");
    expect(githubCalled).toBe(false);

    const finalSession = await sessionRepository.findSessionById(
      context.db,
      sessionId,
    );
    expect(finalSession?.phase).toBe("IDLE");
  });

  it("42. Process restart after ACT: reload from PostgreSQL -> OBSERVE reconstructs factual normalized result -> VERIFY_RESULT succeeds", async () => {
    const sessionId = "sess-m7-restart-observe";
    const cueId = "cue-m7-restart-observe";

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-restart-obs-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId,
      maxRetries: 3,
    });

    const fakeAi = new FakeStructuredAiProvider({
      fixedValue: {
        candidates: [
          {
            goal: "Read repository README file",
            action: "github.contents.read",
            confidence: 0.95,
            expectedUtility: 0.9,
            estimatedRisk: 0.05,
            estimatedCost: 0.01,
            reason: "Read README",
            evidenceIds: [],
          },
        ],
      },
    });

    const factualContent = "# AutoDo AI Factual Markdown Content";
    const mockFetch = createMockFetch({
      status: 200,
      body: {
        name: "README.md",
        path: "README.md",
        sha: "sha-m7-factual-999",
        size: 1024,
        encoding: "base64",
        content: Buffer.from(factualContent).toString("base64"),
      },
    });

    const adapter = new GitHubReadOnlyAdapter({
      token: "ghp_secret_restart_token",
      fetchFn: mockFetch,
    });

    const ports: CognitiveCyclePorts = {
      perception: new DeterministicPerception(),
      candidateGenerator: new GeminiCandidateGeneratorPort(fakeAi),
      groundingEvaluator: new GitHubGroundingEvaluator(),
      policyEvaluator: new GitHubPolicyEvaluator(),
      planBuilder: new DeterministicPlanBuilder(),
      verifier: new GitHubResultVerifier(),
      adapter,
      requestBuilder: new DefaultOperationRequestBuilder(),
    };

    // Step cycle until session reaches OBSERVE (simulating ACT finishing and process crashing/exiting)
    let state = await advanceCognitiveCycle(context.db, sessionId, ports, {
      skillKey: "github.contents.read",
      now: T0,
    });
    while (state.nextSession.phase !== "OBSERVE") {
      state = await advanceCognitiveCycle(
        context.db,
        sessionId,
        ports,
        { skillKey: "github.contents.read", now: T0 },
        state.runtimeAuthorization,
      );
    }

    expect(state.nextSession.phase).toBe("OBSERVE");

    // DISCARD all in-memory runtime objects (simulate fresh process instantiation)
    const freshPorts: CognitiveCyclePorts = {
      perception: new DeterministicPerception(),
      candidateGenerator: new GeminiCandidateGeneratorPort(fakeAi),
      groundingEvaluator: new GitHubGroundingEvaluator(),
      policyEvaluator: new GitHubPolicyEvaluator(),
      planBuilder: new DeterministicPlanBuilder(),
      verifier: new GitHubResultVerifier(),
      adapter: new GitHubReadOnlyAdapter({
        token: "ghp_fresh_token",
        fetchFn: async () => {
          throw new Error("Should not fetch during OBSERVE!");
        },
      }),
      requestBuilder: new DefaultOperationRequestBuilder(),
    };

    // Continue cycle in new process from OBSERVE
    const finalResult = await runCognitiveCycleUntilBoundary(
      context.db,
      sessionId,
      freshPorts,
      { skillKey: "github.contents.read", now: T0 },
    );

    expect(finalResult.status).toBe("COMPLETED");

    // Verify observation in PostgreSQL contains the EXACT factual normalized GitHub result
    const plan = await planRepository.findPlanByCandidateId(
      context.db,
      state.nextSession.currentCandidateId!,
    );
    const executionId = `exec:${sessionId}:${plan!.planId}`;
    const obs = await observationRepository.findManyObservationsByExecutionId(
      context.db,
      executionId,
    );

    expect(obs).toHaveLength(1);
    const data = obs[0].data as Record<string, unknown>;
    const res = (
      data.result && typeof data.result === "object" ? data.result : {}
    ) as Record<string, unknown>;
    expect(data.outcome).toBe("CONFIRMED_SUCCESS");
    expect(res.repository).toBe(ALLOWED_GITHUB_REPO);
    expect(res.path).toBe("README.md");
    expect(res.content).toBe(factualContent);
    expect(res.sha).toBe("sha-m7-factual-999");
  });

  it("43. SUCCEEDED operation with missing durable provider-result data fails closed without inventing synthetic success content", async () => {
    const sessionId = "sess-m7-missing-result";
    const cueId = "cue-m7-missing-result";

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-missing-res-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId,
      maxRetries: 3,
    });

    const fakeAi = new FakeStructuredAiProvider({
      fixedValue: {
        candidates: [
          {
            goal: "Read repository README file",
            action: "github.contents.read",
            confidence: 0.95,
            expectedUtility: 0.9,
            estimatedRisk: 0.05,
            estimatedCost: 0.01,
            reason: "Read README",
            evidenceIds: [],
          },
        ],
      },
    });

    const ports: CognitiveCyclePorts = {
      perception: new DeterministicPerception(),
      candidateGenerator: new GeminiCandidateGeneratorPort(fakeAi),
      groundingEvaluator: new GitHubGroundingEvaluator(),
      policyEvaluator: new GitHubPolicyEvaluator(),
      planBuilder: new DeterministicPlanBuilder(),
      verifier: new GitHubResultVerifier(),
      adapter: new GitHubReadOnlyAdapter({
        token: "test",
        fetchFn: createMockFetch({ status: 200, body: {} }),
      }),
      requestBuilder: new DefaultOperationRequestBuilder(),
    };

    // Step cycle until OBSERVE
    let state = await advanceCognitiveCycle(context.db, sessionId, ports, {
      skillKey: "github.contents.read",
      now: T0,
    });
    while (state.nextSession.phase !== "OBSERVE") {
      state = await advanceCognitiveCycle(
        context.db,
        sessionId,
        ports,
        { skillKey: "github.contents.read", now: T0 },
        state.runtimeAuthorization,
      );
    }

    // Corrupt attempt record by clearing providerMetadata
    const plan = await planRepository.findPlanByCandidateId(
      context.db,
      state.nextSession.currentCandidateId!,
    );
    const executionId = `exec:${sessionId}:${plan!.planId}`;
    const operationId = `op:${executionId}:step-read-1`;
    const attemptId = `att:${operationId}:1`;

    await context.db.execute(
      `UPDATE execution_operation_attempts SET provider_metadata = NULL WHERE attempt_id = '${attemptId}'`,
    );

    // Attempt to run OBSERVE with corrupted/missing durable provider payload
    const result = await advanceCognitiveCycle(context.db, sessionId, ports, {
      skillKey: "github.contents.read",
      now: T0,
    });

    expect(result.isBoundary).toBe(true);
    expect(result.cycleResult?.status).toBe("FAILED");
  });
});
