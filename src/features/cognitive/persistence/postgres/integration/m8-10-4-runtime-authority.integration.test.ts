import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  GitHubReadOnlyAdapter,
  ALLOWED_GITHUB_REPO,
} from "../../../adapters/github/github-adapter";
import { FakeStructuredAiProvider } from "../../../ai/testing/fake-ai-provider";
import { extractDeterministicGitHubTarget } from "../../../api/assistant-ai";
import { executeSessionCycle } from "../../../api/runtime-composition";
import type { AllowedExecutionSafetyState } from "../../../domain/execution-safety";
import { parseGitHubTargetSpec } from "../../../domain/target-spec";
import {
  advanceCognitiveCycle,
  CognitiveCyclePorts,
} from "../../../orchestration/cognitive-loop-driver";
import { GeminiCandidateGeneratorPort } from "../../../orchestration/gemini-candidate-generator";
import { GitHubGroundingEvaluator } from "../../../orchestration/github-grounding-policy";
import { GitHubPolicyEvaluator } from "../../../orchestration/github-grounding-policy";
import { GitHubResultVerifier } from "../../../orchestration/github-result-verifier";
import { DefaultOperationRequestBuilder } from "../../../orchestration/operation-request-builder";
import type {
  PerceptionPort,
  PlanBuilderPort,
  PlanProposal,
} from "../../../orchestration/cognitive-ports";
import type { PerceptionResult } from "../../../orchestration/context-assembler";
import type { PersistedCandidateAction } from "../../contracts/persisted-candidate-action";
import type { PersistedCueIngress } from "../../contracts/cue-ingress";
import type { AssembledCognitiveContext } from "../../../orchestration/context-assembler";
import { candidateRepository } from "../repositories/candidate-repository";
import { executionOperationRepository } from "../repositories/execution-operation-repository";
import { executionRepository } from "../repositories/execution-repository";
import { groundingRepository } from "../repositories/grounding-repository";
import { policyRepository } from "../repositories/policy-repository";
import { safetyRepository } from "../repositories/safety-repository";
import { sessionRepository } from "../repositories/session-repository";
import { eq } from "drizzle-orm";
import { executionOperations, executionStepState } from "../schema/execution";
import { GET as getHealthRoute } from "../../../../../app/api/cognitive/providers/health/route";
import type { PostgresDatabaseContext } from "../client";
import {
  cleanIntegrationTestTables,
  setupIntegrationTestDatabase,
} from "../testing/integration-harness";
import { ingestCue } from "../transactions/ingest-cue";
import { persistAuthorizationIssuance } from "../transactions/persist-authorization-issuance";
import {
  recordOperationFailed,
  recordOperationSucceeded,
} from "../../../orchestration/execution-outcome-orchestrator";

const T0 = "2026-08-31T05:00:00.000Z";

class TestPerception implements PerceptionPort {
  async perceive(cue: PersistedCueIngress): Promise<PerceptionResult> {
    const payload = (
      cue.payload && typeof cue.payload === "object" ? cue.payload : {}
    ) as Record<string, unknown>;
    const path = typeof payload.path === "string" ? payload.path : "README.md";
    const action =
      typeof payload.requestedAction === "string"
        ? payload.requestedAction
        : typeof payload.action === "string"
          ? payload.action
          : "github.contents.read";
    return {
      summary: `Perceived task: ${cue.type}`,
      structuredFacts: {
        action,
        targetRepo: ALLOWED_GITHUB_REPO,
        path,
        requestedFile: path,
      },
      perceivedAt: T0,
    };
  }
}

class TestPlanBuilder implements PlanBuilderPort {
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
          stepId: "step-test-1",
          ordinal: 0,
          description: `Execute read operation ${candidate.action} on ${ALLOWED_GITHUB_REPO}`,
        },
      ],
      dependencies: [],
    };
  }
}

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

describe("Milestone 8.10.4 — Runtime Authority, Recovery & Verification Closure (Integration Suite)", () => {
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

  // =========================================================================
  // Test A: Single-step execution with valid targetSpec succeeds to IDLE
  // =========================================================================
  it("Test A: Single-step execution with valid targetSpec succeeds and reaches IDLE with verified facts", async () => {
    const sessionId = "sess-m8104-success";
    const cueId = "cue-m8104-success";

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test-user",
        externalEventId: "ev-m8104-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {
          prompt: "Read README.md from repository",
          path: "README.md",
        },
      },
      sessionId,
      maxRetries: 3,
    });

    const fakeAi = new FakeStructuredAiProvider({
      fixedValue: {
        candidates: [
          {
            goal: "Read README.md documentation",
            action: "github.contents.read",
            confidence: 0.98,
            expectedUtility: 0.95,
            estimatedRisk: 0.05,
            estimatedCost: 0.01,
            reason: "Read README",
            evidenceIds: [],
          },
        ],
      },
    });

    let adapterDispatches = 0;
    const adapter = new GitHubReadOnlyAdapter({
      token: "test-token",
      fetchFn: async (url, init) => {
        adapterDispatches++;
        return createMockFetch({
          status: 200,
          body: {
            path: "README.md",
            size: 42,
            encoding: "base64",
            content: Buffer.from("# AutoDo AI Project").toString("base64"),
          },
        })(url, init);
      },
    });

    const ports: CognitiveCyclePorts = {
      perception: new TestPerception(),
      candidateGenerator: new GeminiCandidateGeneratorPort(fakeAi),
      groundingEvaluator: new GitHubGroundingEvaluator(),
      policyEvaluator: new GitHubPolicyEvaluator(),
      planBuilder: new TestPlanBuilder(),
      verifier: new GitHubResultVerifier(),
      adapter,
      requestBuilder: new DefaultOperationRequestBuilder(),
    };

    const cycleOutcome = await executeSessionCycle(context.db, sessionId, {
      taskProfile: "github-readonly-v1",
      ports,
      now: T0,
    });

    expect(cycleOutcome.result?.status).toBe("COMPLETED");
    expect(cycleOutcome.session.phase).toBe("IDLE");
    expect(adapterDispatches).toBe(1);

    if (cycleOutcome.result?.status === "COMPLETED") {
      const exec = await executionRepository.findExecutionById(
        context.db,
        cycleOutcome.result.executionId,
      );
      expect(exec).not.toBeNull();
      expect(exec?.status).toBe("SUCCEEDED");
    }
  });

  // =========================================================================
  // Test B: Deterministic target extraction from natural language
  // =========================================================================
  it("Test B: Deterministically extracts explicit target identities from natural language without guessing", () => {
    // Issue extraction
    const issueTarget = extractDeterministicGitHubTarget(
      "Read issue #47 and summarize its current status",
    );
    expect(issueTarget?.issueNumber).toBe(47);
    expect(issueTarget?.actionHint).toBe("github.issue.get");

    // PR extraction
    const prTarget = extractDeterministicGitHubTarget(
      "Check PR #12 to see if tests passed",
    );
    expect(prTarget?.pullNumber).toBe(12);
    expect(prTarget?.actionHint).toBe("github.pull_request.get");

    // File extraction
    const fileTarget = extractDeterministicGitHubTarget(
      "Please inspect package.json dependencies",
    );
    expect(fileTarget?.path).toBe("package.json");
    expect(fileTarget?.actionHint).toBe("github.contents.read");

    // Ambiguous target rejects default guessing
    const ambiguousTarget = extractDeterministicGitHubTarget(
      "Show me what's happening",
    );
    expect(ambiguousTarget.issueNumber).toBeUndefined();
    expect(ambiguousTarget.pullNumber).toBeUndefined();
    expect(ambiguousTarget.path).toBeUndefined();
    expect(ambiguousTarget.actionHint).toBeUndefined();
  });

  // =========================================================================
  // Test C: Context assembler fail-closed on missing/invalid targetSpec
  // =========================================================================
  it("Test C: Context assembler fails closed on invalid targetSpec", async () => {
    const invalidTarget = () =>
      parseGitHubTargetSpec("github.issue.get", "check issues", {});
    expect(invalidTarget).toThrowError(/Missing or invalid issueNumber/);

    const invalidFileTarget = () =>
      parseGitHubTargetSpec("github.contents.read", "check repo", {});
    expect(invalidFileTarget).toThrowError(/Missing or invalid path/);

    const unknownAction = () =>
      parseGitHubTargetSpec("github.mutate.delete", "delete branch", {});
    expect(unknownAction).toThrowError(/Unsupported or unknown action/);
  });

  // =========================================================================
  // Test D: GitHubResultVerifier detects mismatch between expectedResult and observed facts
  // =========================================================================
  it("Test D: GitHubResultVerifier rejects mismatched observed provider facts (wrong issue # or file path)", async () => {
    const verifier = new GitHubResultVerifier();

    // 1. Path mismatch for file read
    const fileVerification = await verifier.verify({
      execution: {
        executionId: "exec-test-d1",
        sessionId: "sess-test-d1",
        planId: "plan-test-d1",
        status: "RUNNING",
        currentStepId: "step-1",
        startedAt: T0,
        completedAt: null,
        error: null,
        rowVersion: 1,
        safetyGenerationAtStart: 1,
        createdAt: T0,
        updatedAt: T0,
      },
      observations: [
        {
          observationId: "obs-d1",
          executionId: "exec-test-d1",
          stepId: "step-1",
          source: "provider-dispatch",
          sourceEventId: "ev-d1",
          summary: "Read file",
          data: {
            outcome: "CONFIRMED_SUCCESS",
            operationKind: "github.contents.read",
            providerScope: "github-rest",
            result: {
              repository: ALLOWED_GITHUB_REPO,
              path: "wrong-file.ts",
              content: "export const x = 1;",
              size: 20,
            },
            finishedAt: T0,
          },
          observedAt: T0,
          payloadExpiresAt: null,
        },
      ],
      expectedResult: {
        kind: "FILE",
        repository: ALLOWED_GITHUB_REPO,
        owner: "nelson1869-ai",
        repo: "01",
        path: "README.md",
      },
    });

    expect(fileVerification.status).toBe("FAILED");
    expect(fileVerification.reason).toContain(
      "does not match expected target path",
    );

    // 2. Issue number mismatch
    const issueVerification = await verifier.verify({
      execution: {
        executionId: "exec-test-d2",
        sessionId: "sess-test-d2",
        planId: "plan-test-d2",
        status: "RUNNING",
        currentStepId: "step-1",
        startedAt: T0,
        completedAt: null,
        error: null,
        rowVersion: 1,
        safetyGenerationAtStart: 1,
        createdAt: T0,
        updatedAt: T0,
      },
      observations: [
        {
          observationId: "obs-d2",
          executionId: "exec-test-d2",
          stepId: "step-1",
          source: "provider-dispatch",
          sourceEventId: "ev-d2",
          summary: "Get issue",
          data: {
            outcome: "CONFIRMED_SUCCESS",
            operationKind: "github.issue.get",
            providerScope: "github-rest",
            result: {
              repository: ALLOWED_GITHUB_REPO,
              number: 1,
              title: "Initial issue",
            },
            finishedAt: T0,
          },
          observedAt: T0,
          payloadExpiresAt: null,
        },
      ],
      expectedResult: {
        kind: "ISSUE",
        repository: ALLOWED_GITHUB_REPO,
        owner: "nelson1869-ai",
        repo: "01",
        issueNumber: 47,
      },
    });

    expect(issueVerification.status).toBe("FAILED");
    expect(issueVerification.reason).toContain(
      "does not match expected target issue #47",
    );

    // 3. List operations: wrong repository fails
    const wrongRepoListVerification = await verifier.verify({
      execution: {
        executionId: "exec-test-d3",
        sessionId: "sess-test-d3",
        planId: "plan-test-d3",
        status: "RUNNING",
        currentStepId: "step-1",
        startedAt: T0,
        completedAt: null,
        error: null,
        rowVersion: 1,
        safetyGenerationAtStart: 1,
        createdAt: T0,
        updatedAt: T0,
      },
      observations: [
        {
          observationId: "obs-d3",
          executionId: "exec-test-d3",
          stepId: "step-1",
          source: "provider-dispatch",
          sourceEventId: "ev-d3",
          summary: "List issues",
          data: {
            outcome: "CONFIRMED_SUCCESS",
            operationKind: "github.issues.list",
            providerScope: "github-rest",
            result: {
              repository: "other-org/other-repo",
              issues: [],
            },
            finishedAt: T0,
          },
          observedAt: T0,
          payloadExpiresAt: null,
        },
      ],
      expectedResult: {
        kind: "ISSUE_LIST",
        repository: ALLOWED_GITHUB_REPO,
        owner: "nelson1869-ai",
        repo: "01",
        state: "open",
        perPage: 10,
      },
    });
    expect(wrongRepoListVerification.status).toBe("FAILED");
    expect(wrongRepoListVerification.reason).toContain(
      "does not match allowed repository",
    );

    // 4. List operations: wrong expected kind fails
    const wrongKindListVerification = await verifier.verify({
      execution: {
        executionId: "exec-test-d4",
        sessionId: "sess-test-d4",
        planId: "plan-test-d4",
        status: "RUNNING",
        currentStepId: "step-1",
        startedAt: T0,
        completedAt: null,
        error: null,
        rowVersion: 1,
        safetyGenerationAtStart: 1,
        createdAt: T0,
        updatedAt: T0,
      },
      observations: [
        {
          observationId: "obs-d4",
          executionId: "exec-test-d4",
          stepId: "step-1",
          source: "provider-dispatch",
          sourceEventId: "ev-d4",
          summary: "List issues",
          data: {
            outcome: "CONFIRMED_SUCCESS",
            operationKind: "github.issues.list",
            providerScope: "github-rest",
            result: {
              repository: ALLOWED_GITHUB_REPO,
              issues: [],
            },
            finishedAt: T0,
          },
          observedAt: T0,
          payloadExpiresAt: null,
        },
      ],
      expectedResult: {
        kind: "PULL_REQUEST_LIST",
        repository: ALLOWED_GITHUB_REPO,
        owner: "nelson1869-ai",
        repo: "01",
        state: "open",
        perPage: 10,
      },
    });
    expect(wrongKindListVerification.status).toBe("FAILED");
    expect(wrongKindListVerification.reason).toContain(
      "does not match operation kind",
    );

    // 5. List operations: valid empty and populated lists succeed with canonical kind
    const validEmptyListVerification = await verifier.verify({
      execution: {
        executionId: "exec-test-d5",
        sessionId: "sess-test-d5",
        planId: "plan-test-d5",
        status: "RUNNING",
        currentStepId: "step-1",
        startedAt: T0,
        completedAt: null,
        error: null,
        rowVersion: 1,
        safetyGenerationAtStart: 1,
        createdAt: T0,
        updatedAt: T0,
      },
      observations: [
        {
          observationId: "obs-d5",
          executionId: "exec-test-d5",
          stepId: "step-1",
          source: "provider-dispatch",
          sourceEventId: "ev-d5",
          summary: "List PRs",
          data: {
            outcome: "CONFIRMED_SUCCESS",
            operationKind: "github.pull_requests.list",
            providerScope: "github-rest",
            result: {
              repository: ALLOWED_GITHUB_REPO,
              pullRequests: [],
            },
            finishedAt: T0,
          },
          observedAt: T0,
          payloadExpiresAt: null,
        },
      ],
      expectedResult: {
        kind: "PULL_REQUEST_LIST",
        repository: ALLOWED_GITHUB_REPO,
        owner: "nelson1869-ai",
        repo: "01",
        state: "open",
        perPage: 10,
      },
    });
    expect(validEmptyListVerification.status).toBe("VERIFIED");

    // 6. Valid populated issues list with canonical ISSUE_LIST succeeds
    const validIssuesListVerification = await verifier.verify({
      execution: {
        executionId: "exec-test-d6",
        sessionId: "sess-test-d6",
        planId: "plan-test-d6",
        status: "RUNNING",
        currentStepId: "step-1",
        startedAt: T0,
        completedAt: null,
        error: null,
        rowVersion: 1,
        safetyGenerationAtStart: 1,
        createdAt: T0,
        updatedAt: T0,
      },
      observations: [
        {
          observationId: "obs-d6",
          executionId: "exec-test-d6",
          stepId: "step-1",
          source: "provider-dispatch",
          sourceEventId: "ev-d6",
          summary: "List issues",
          data: {
            outcome: "CONFIRMED_SUCCESS",
            operationKind: "github.issues.list",
            providerScope: "github-rest",
            result: {
              repository: ALLOWED_GITHUB_REPO,
              count: 1,
              issues: [
                {
                  number: 1,
                  title: "Test Issue",
                  state: "open",
                  body: "Issue body",
                },
              ],
            },
            finishedAt: T0,
          },
          observedAt: T0,
          payloadExpiresAt: null,
        },
      ],
      expectedResult: {
        kind: "ISSUE_LIST",
        repository: ALLOWED_GITHUB_REPO,
        owner: "nelson1869-ai",
        repo: "01",
        state: "open",
        perPage: 10,
      },
    });
    expect(validIssuesListVerification.status).toBe("VERIFIED");
  });

  // =========================================================================
  // Test E: Crash resumption in ACT when operation is already SUCCEEDED
  // =========================================================================
  it("Test E: Crash resumption in ACT when operation is already SUCCEEDED finalizes step + execution without adapter redispatch", async () => {
    const sessionId = "sess-m8104-crash-succ";
    const cueId = "cue-m8104-crash-succ";

    const { session } = await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-crash-succ-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: { path: "README.md" },
      },
      sessionId,
      maxRetries: 3,
    });

    // 1. Advance through PERCEIVE, BUILD_CONTEXT, GENERATE_CANDIDATES, SCORE, GROUND_VERIFY, POLICY_SAFETY, PLAN
    const fakeAi = new FakeStructuredAiProvider({
      fixedValue: {
        candidates: [
          {
            goal: "Read README.md",
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

    let adapterDispatched = 0;
    const adapter = new GitHubReadOnlyAdapter({
      token: "test-token",
      fetchFn: async () => {
        adapterDispatched++;
        return new Response(
          JSON.stringify({ path: "README.md", content: "dGVzdA==" }),
          {
            status: 200,
          },
        );
      },
    });

    const ports: CognitiveCyclePorts = {
      perception: new TestPerception(),
      candidateGenerator: new GeminiCandidateGeneratorPort(fakeAi),
      groundingEvaluator: new GitHubGroundingEvaluator(),
      policyEvaluator: new GitHubPolicyEvaluator(),
      planBuilder: new TestPlanBuilder(),
      verifier: new GitHubResultVerifier(),
      adapter,
      requestBuilder: new DefaultOperationRequestBuilder(),
    };

    // Advance session until ACT
    let currentSession = session;
    let auth: AllowedExecutionSafetyState | undefined = undefined;
    while (currentSession.phase !== "ACT") {
      const step = await advanceCognitiveCycle(
        context.db,
        currentSession.sessionId,
        ports,
        {
          skillKey: "github.contents.read",
          now: T0,
          runtimeAuthorization: auth,
        },
      );
      auth = step.runtimeAuthorization ?? auth;
      currentSession = step.nextSession;
    }

    expect(currentSession.phase).toBe("ACT");

    // Simulate pre-existing SUCCEEDED operation (e.g. executed before process crash)
    const plan = await sessionRepository.findSessionById(context.db, sessionId);
    const executionId = `exec:${sessionId}:${plan!.currentPlanId}`;
    const op = await executionOperationRepository.findOperationById(
      context.db,
      `op:${executionId}:step-test-1`,
    );
    expect(op).not.toBeNull();

    // Start attempt 1 in DB to simulate in-flight execution prior to crash
    const { operation: inFlightOp, attempt } =
      await executionOperationRepository.beginAttempt(context.db, {
        operationId: op!.operationId,
        attemptId: `att:${op!.operationId}:1`,
        workerId: "test-worker",
        expectedRowVersion: op!.rowVersion,
        startedAt: T0,
      });

    // Mark operation as SUCCEEDED in DB directly to simulate pre-crash completion
    await recordOperationSucceeded(context.db, {
      commandIdempotencyKey: `sim-succ:${op!.operationId}`,
      operationId: op!.operationId,
      attemptId: attempt.attemptId,
      expectedOperationRowVersion: inFlightOp.rowVersion,
      outcome: "SUCCEEDED",
      providerOperationId: "github-op-123",
      resultMetadata: {
        repository: ALLOWED_GITHUB_REPO,
        path: "README.md",
        content: "test",
        size: 4,
      },
      finishedAt: T0,
    });

    // Now resume cycle in ACT: it must detect SUCCEEDED, reload row versions, complete step and execution, and advance to OBSERVE without calling adapter!
    const actResult = await advanceCognitiveCycle(
      context.db,
      sessionId,
      ports,
      {
        skillKey: "github.contents.read",
        now: T0,
        runtimeAuthorization: auth,
      },
    );

    expect(actResult.nextSession.phase).toBe("OBSERVE");
    expect(adapterDispatched).toBe(0); // ZERO adapter redispatch!
  });

  // =========================================================================
  // Test F: Crash resumption in ACT when operation is already FAILED
  // =========================================================================
  it("Test F: Crash resumption in ACT when operation is already FAILED finalizes failure ledgers without adapter redispatch", async () => {
    const sessionId = "sess-m8104-crash-fail";
    const cueId = "cue-m8104-crash-fail";

    const { session } = await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-crash-fail-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: { path: "README.md" },
      },
      sessionId,
      maxRetries: 3,
    });

    const fakeAi = new FakeStructuredAiProvider({
      fixedValue: {
        candidates: [
          {
            goal: "Read README.md",
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

    let adapterDispatched = 0;
    const adapter = new GitHubReadOnlyAdapter({
      token: "test-token",
      fetchFn: async () => {
        adapterDispatched++;
        return new Response("{}", { status: 500 });
      },
    });

    const ports: CognitiveCyclePorts = {
      perception: new TestPerception(),
      candidateGenerator: new GeminiCandidateGeneratorPort(fakeAi),
      groundingEvaluator: new GitHubGroundingEvaluator(),
      policyEvaluator: new GitHubPolicyEvaluator(),
      planBuilder: new TestPlanBuilder(),
      verifier: new GitHubResultVerifier(),
      adapter,
      requestBuilder: new DefaultOperationRequestBuilder(),
    };

    let currentSession = session;
    let auth: AllowedExecutionSafetyState | undefined = undefined;
    while (currentSession.phase !== "ACT") {
      const step = await advanceCognitiveCycle(
        context.db,
        currentSession.sessionId,
        ports,
        {
          skillKey: "github.contents.read",
          now: T0,
          runtimeAuthorization: auth,
        },
      );
      auth = step.runtimeAuthorization ?? auth;
      currentSession = step.nextSession;
    }

    expect(currentSession.phase).toBe("ACT");

    const plan = await sessionRepository.findSessionById(context.db, sessionId);
    const executionId = `exec:${sessionId}:${plan!.currentPlanId}`;
    const op = await executionOperationRepository.findOperationById(
      context.db,
      `op:${executionId}:step-test-1`,
    );
    expect(op).not.toBeNull();

    // Start attempt 1 in DB to simulate in-flight execution prior to crash
    const { operation: inFlightOpFail, attempt: attemptFail } =
      await executionOperationRepository.beginAttempt(context.db, {
        operationId: op!.operationId,
        attemptId: `att:${op!.operationId}:1`,
        workerId: "test-worker",
        expectedRowVersion: op!.rowVersion,
        startedAt: T0,
      });

    // Record pre-crash failure in database
    await recordOperationFailed(context.db, {
      commandIdempotencyKey: `sim-fail:${op!.operationId}`,
      operationId: op!.operationId,
      attemptId: attemptFail.attemptId,
      expectedOperationRowVersion: inFlightOpFail.rowVersion,
      outcome: "FAILED",
      errorSummary:
        "Simulated upstream provider timeout prior to process restart.",
      finishedAt: T0,
    });

    // Advance cycle from ACT: must finalize failure and advance to OBSERVE without redispatch
    const actResult = await advanceCognitiveCycle(
      context.db,
      sessionId,
      ports,
      {
        skillKey: "github.contents.read",
        now: T0,
        runtimeAuthorization: auth,
      },
    );

    expect(actResult.nextSession.phase).toBe("OBSERVE");
    expect(adapterDispatched).toBe(0); // ZERO adapter redispatch!
  });

  // =========================================================================
  // Test G: CAS validation in authorization issuance rejects stale evaluationGeneration
  // =========================================================================
  it("Test G: Authorize issuance rejects candidate generated under an older evaluation generation", async () => {
    const sessionId = "sess-m8104-cas-auth";
    const cueId = "cue-m8104-cas-auth";

    const { session } = await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-cas-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: {},
      },
      sessionId,
      maxRetries: 3,
    });

    // Persist candidate under generation 1
    const { candidate } = await candidateRepository.appendCandidate(
      context.db,
      {
        candidateId: "cand-cas-1",
        sessionId,
        cueId,
        evaluationGeneration: 1,
        goal: "Read README",
        action: "github.contents.read",
        confidence: 0.9,
        expectedUtility: 0.9,
        estimatedRisk: 0.05,
        estimatedCost: 0.01,
        scoreValue: 0.9,
        recommendation: "AUTO_CANDIDATE",
        scoreFormulaVersion: "v1",
        evidenceIds: [],
        createdAt: T0,
      },
    );

    const { grounding } = await groundingRepository.appendGroundingResult(
      context.db,
      {
        groundingResultId: "gr-cas-1",
        candidateId: candidate.candidateId,
        evaluationKey: "eval:gr:1",
        status: "VERIFIED",
        confidence: 1.0,
        reason: "Grounded on target repo",
        evidenceIds: [],
        evaluatorVersion: "v1",
        evaluatedAt: T0,
      },
    );

    const { decision: policy } = await policyRepository.appendPolicyDecision(
      context.db,
      {
        policyDecisionId: "pol-cas-1",
        candidateId: candidate.candidateId,
        groundingResultId: grounding.groundingResultId,
        evaluationKey: "eval:pol:1",
        outcome: "ALLOW",
        reason: "Policy allows readonly operation",
        policyEngineVersion: "v1",
        evaluatedAt: T0,
        policyIds: ["pol:readonly:1"],
      },
    );

    // Transition session to POLICY_SAFETY with evaluationGeneration 2
    const updatedSession = await sessionRepository.transitionSession(
      context.db,
      {
        sessionId,
        expectedRowVersion: session.rowVersion,
        expectedPhase: session.phase,
        expectedCandidateId: session.currentCandidateId,
        nextSessionState: {
          phase: "POLICY_SAFETY",
          failureCount: session.failureCount,
          retryCount: session.retryCount,
          maxRetries: session.maxRetries,
          evaluationGeneration: 2,
          cooldownUntil: session.cooldownUntil,
          currentCandidateId: candidate.candidateId,
          currentPlanId: session.currentPlanId,
          currentExecutionId: session.currentExecutionId,
          updatedAt: T0,
        },
      },
    );

    const safety = await safetyRepository.findSafetyStateBySessionId(
      context.db,
      sessionId,
    );

    // Attempt to authorize issuance with candidate from generation 1 against session generation 2
    await expect(
      persistAuthorizationIssuance(context.db, {
        commandIdempotencyKey: "cmd:auth:cas:fail",
        sessionId,
        candidateId: candidate.candidateId,
        groundingResultId: grounding.groundingResultId,
        policyDecisionId: policy.policyDecisionId,
        expectedSessionRowVersion: updatedSession.rowVersion,
        expectedSafetyGeneration: safety!.generation,
        safetyEventId: "ev-safety-cas:1",
        safetyEventKey: "ev-key-safety-cas:1",
        issuedAt: T0,
      }),
    ).rejects.toThrowError(/does not match session.*generation/);
  });

  // =========================================================================
  // Test H: Pre-persistence secret safety blocks cue ingestion on secret leak
  // =========================================================================
  it("Test H: Pre-persistence secret safety blocks cue ingestion when a secret token is present in payload", async () => {
    const sessionId = "sess-m8104-secret-block";
    const cueId = "cue-m8104-secret-block";

    await expect(
      ingestCue(context.db, {
        cue: {
          cueId,
          source: "test",
          externalEventId: "ev-sec-leak-1",
          type: "user.action",
          occurredAt: T0,
          receivedAt: T0,
          payload: {
            token: "ghp_1234567890abcdefghijklmnopqrstuvwxyz1234",
          },
        },
        sessionId,
        maxRetries: 3,
      }),
    ).rejects.toThrowError(/Disallowed property "token"|Security violation/);

    const savedCue = await sessionRepository.findSessionById(
      context.db,
      sessionId,
    );
    expect(savedCue).toBeNull(); // Nothing was persisted!
  });

  // =========================================================================
  // Test I: Pure cognition whitelist allows evaluation when safety is BLOCKED
  // =========================================================================
  it("Test I: Top-level safety allows pure cognition phases when safety is BLOCKED, but blocks external execution phases", async () => {
    const sessionId = "sess-m8104-pure-cognition";
    const cueId = "cue-m8104-pure-cognition";

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-pure-cog-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: { path: "README.md" },
      },
      sessionId,
      maxRetries: 3,
    });

    // Mark safety as BLOCKED
    const safety = await safetyRepository.findSafetyStateBySessionId(
      context.db,
      sessionId,
    );
    await safetyRepository.transitionSafety(context.db, {
      commandIdempotencyKey: `safety-block:${sessionId}`,
      sessionId,
      expectedGeneration: safety!.generation,
      nextState: {
        sessionId,
        generation: safety!.generation + 1,
        status: "BLOCKED",
        reason: "Manual administrative lock",
        failure: "POLICY_VIOLATION",
        blockedAt: T0,
        evaluatedCandidateId: null,
        groundingResultId: null,
        policyDecisionId: null,
        updatedAt: T0,
      },
    });

    const ports: CognitiveCyclePorts = {
      perception: new TestPerception(),
      candidateGenerator: new GeminiCandidateGeneratorPort(
        new FakeStructuredAiProvider({ fixedValue: { candidates: [] } }),
      ),
      groundingEvaluator: new GitHubGroundingEvaluator(),
      policyEvaluator: new GitHubPolicyEvaluator(),
      planBuilder: new TestPlanBuilder(),
      verifier: new GitHubResultVerifier(),
      adapter: new GitHubReadOnlyAdapter({ token: "test-token" }),
      requestBuilder: new DefaultOperationRequestBuilder(),
    };

    // Advancing from CUE succeeds through PERCEIVE even though safety is BLOCKED
    const perceiveStep = await advanceCognitiveCycle(
      context.db,
      sessionId,
      ports,
      {
        skillKey: "github.contents.read",
        now: T0,
      },
    );
    expect(perceiveStep.nextSession.phase).toBe("PERCEIVE");

    // But if session is in PLAN or ACT, it immediately returns BLOCKED boundary
    await sessionRepository.transitionSession(context.db, {
      sessionId,
      expectedRowVersion: perceiveStep.nextSession.rowVersion,
      expectedPhase: "PERCEIVE",
      expectedCandidateId: null,
      nextSessionState: {
        phase: "PLAN",
        failureCount: 0,
        retryCount: 0,
        maxRetries: 3,
        evaluationGeneration: 1,
        cooldownUntil: null,
        currentCandidateId: "cand-test-1",
        currentPlanId: null,
        currentExecutionId: null,
        updatedAt: T0,
      },
    });
    const planStep = await advanceCognitiveCycle(context.db, sessionId, ports, {
      skillKey: "github.contents.read",
      now: T0,
    });
    expect(planStep.isBoundary).toBe(true);
    expect(planStep.cycleResult?.status).toBe("BLOCKED");
  });

  // =========================================================================
  // Test J: DURABLE_EXECUTION crash resumption and reconciliation with missing auth
  // =========================================================================
  it("Test J: DURABLE_EXECUTION handles IN_FLIGHT, UNKNOWN, SUCCEEDED, FAILED, and PENDING on missing authorization without adapter redispatch", async () => {
    const sessionId = "sess-m8104-durable-rec";
    const cueId = "cue-m8104-durable-rec";

    const { session } = await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-dur-rec-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: { path: "README.md" },
      },
      sessionId,
      maxRetries: 3,
    });

    const fakeAi = new FakeStructuredAiProvider({
      fixedValue: {
        candidates: [
          {
            goal: "Read README.md",
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

    let adapterDispatched = 0;
    const adapter = new GitHubReadOnlyAdapter({
      token: "test-token",
      fetchFn: async () => {
        adapterDispatched++;
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          json: async () => ({
            name: "01",
            path: "README.md",
            sha: "abc1234",
            size: 4,
            content: Buffer.from("test").toString("base64"),
            encoding: "base64",
          }),
        } as unknown as Response;
      },
    });

    const ports: CognitiveCyclePorts = {
      perception: new TestPerception(),
      candidateGenerator: new GeminiCandidateGeneratorPort(fakeAi),
      groundingEvaluator: new GitHubGroundingEvaluator(),
      policyEvaluator: new GitHubPolicyEvaluator(),
      planBuilder: new TestPlanBuilder(),
      verifier: new GitHubResultVerifier(),
      adapter,
      requestBuilder: new DefaultOperationRequestBuilder(),
    };

    // 1. Advance through PLAN to DURABLE_EXECUTION
    let currentSession = session;
    let auth: AllowedExecutionSafetyState | undefined = undefined;
    while (currentSession.phase !== "DURABLE_EXECUTION") {
      const step = await advanceCognitiveCycle(
        context.db,
        currentSession.sessionId,
        ports,
        {
          skillKey: "github.contents.read",
          now: T0,
          runtimeAuthorization: auth,
        },
      );
      auth = step.runtimeAuthorization ?? auth;
      currentSession = step.nextSession;
    }

    expect(currentSession.phase).toBe("DURABLE_EXECUTION");

    // Advance one more step with auth to execute DURABLE_EXECUTION (which reserves the operation)
    const durableStep = await advanceCognitiveCycle(
      context.db,
      currentSession.sessionId,
      ports,
      {
        skillKey: "github.contents.read",
        now: T0,
        runtimeAuthorization: auth,
      },
    );
    auth = durableStep.runtimeAuthorization ?? auth;
    currentSession = durableStep.nextSession;
    expect(currentSession.phase).toBe("ACT");

    // Transition session back to DURABLE_EXECUTION to test crash/recovery behavior in DURABLE_EXECUTION
    currentSession = await sessionRepository.transitionSession(context.db, {
      sessionId,
      expectedRowVersion: currentSession.rowVersion,
      expectedPhase: "ACT",
      expectedCandidateId: currentSession.currentCandidateId,
      nextSessionState: {
        phase: "DURABLE_EXECUTION",
        failureCount: currentSession.failureCount,
        retryCount: currentSession.retryCount,
        maxRetries: currentSession.maxRetries,
        evaluationGeneration: currentSession.evaluationGeneration,
        cooldownUntil: currentSession.cooldownUntil,
        currentCandidateId: currentSession.currentCandidateId,
        currentPlanId: currentSession.currentPlanId,
        currentExecutionId: currentSession.currentExecutionId,
        updatedAt: T0,
      },
    });

    const plan = await sessionRepository.findSessionById(context.db, sessionId);
    const executionId = `exec:${sessionId}:${plan!.currentPlanId}`;
    const op = await executionOperationRepository.findOperationById(
      context.db,
      `op:${executionId}:step-test-1`,
    );
    expect(op).not.toBeNull();

    // Begin attempt 1 to simulate IN_FLIGHT state
    const { operation: inFlightOp } =
      await executionOperationRepository.beginAttempt(context.db, {
        operationId: op!.operationId,
        attemptId: `att:${op!.operationId}:1`,
        workerId: "test-worker",
        expectedRowVersion: op!.rowVersion,
        startedAt: T0,
      });

    // 1. Case A: IN_FLIGHT -> yields RECONCILIATION_REQUIRED on missing auth (0 redispatch)
    const inFlightResult = await advanceCognitiveCycle(
      context.db,
      sessionId,
      ports,
      {
        skillKey: "github.contents.read",
        now: T0,
        runtimeAuthorization: undefined, // Missing auth!
      },
    );
    expect(inFlightResult.isBoundary).toBe(true);
    expect(inFlightResult.cycleResult?.status).toBe("RECONCILIATION_REQUIRED");
    expect(adapterDispatched).toBe(0);

    // 2. Case B: SUCCEEDED -> resumes to OBSERVE on missing auth (0 redispatch)
    await recordOperationSucceeded(context.db, {
      commandIdempotencyKey: `sim-succ-dur:${op!.operationId}`,
      operationId: op!.operationId,
      attemptId: `att:${op!.operationId}:1`,
      expectedOperationRowVersion: inFlightOp.rowVersion,
      outcome: "SUCCEEDED",
      providerOperationId: "github-op-succ",
      resultMetadata: {
        repository: ALLOWED_GITHUB_REPO,
        path: "README.md",
        content: "test",
        size: 4,
      },
      finishedAt: T0,
    });

    const succResult = await advanceCognitiveCycle(
      context.db,
      sessionId,
      ports,
      {
        skillKey: "github.contents.read",
        now: T0,
        runtimeAuthorization: undefined, // Missing auth!
      },
    );
    expect(succResult.nextSession.phase).toBe("OBSERVE");
    expect(adapterDispatched).toBe(0);
  });

  // =========================================================================
  // Test K: Defensive completion invariant guard
  // =========================================================================
  it("Test K: Defensive completion invariant guard verifies steps and durable operations are SUCCEEDED before returning COMPLETED", async () => {
    const sessionId = "sess-m8104-defensive-comp";
    const cueId = "cue-m8104-defensive-comp";

    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "test",
        externalEventId: "ev-def-comp-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: { path: "README.md" },
      },
      sessionId,
      maxRetries: 3,
    });

    const fakeAi = new FakeStructuredAiProvider({
      fixedValue: {
        candidates: [
          {
            goal: "Read README.md",
            action: "github.contents.read",
            confidence: 0.98,
            expectedUtility: 0.95,
            estimatedRisk: 0.05,
            estimatedCost: 0.01,
            reason: "Read README",
            evidenceIds: [],
          },
        ],
      },
    });

    const adapter = new GitHubReadOnlyAdapter({
      token: "test-token",
      fetchFn: async (url, init) => {
        return createMockFetch({
          status: 200,
          body: {
            path: "README.md",
            size: 42,
            encoding: "base64",
            content: Buffer.from("# AutoDo AI Project").toString("base64"),
          },
        })(url, init);
      },
    });

    const ports: CognitiveCyclePorts = {
      perception: new TestPerception(),
      candidateGenerator: new GeminiCandidateGeneratorPort(fakeAi),
      groundingEvaluator: new GitHubGroundingEvaluator(),
      policyEvaluator: new GitHubPolicyEvaluator(),
      planBuilder: new TestPlanBuilder(),
      verifier: new GitHubResultVerifier(),
      adapter,
      requestBuilder: new DefaultOperationRequestBuilder(),
    };

    const cycleOutcome = await executeSessionCycle(context.db, sessionId, {
      taskProfile: "github-readonly-v1",
      ports,
      now: T0,
    });

    expect(cycleOutcome.result?.status).toBe("COMPLETED");
    expect(cycleOutcome.session.phase).toBe("IDLE");

    // Regression check 1: VERIFIED + execution SUCCEEDED + operation UNKNOWN -> NOT COMPLETED (returns FAILED)
    const sessUnknown = "sess-m8104-def-unknown";
    const cueUnknown = "cue-m8104-def-unknown";
    const { session: s1 } = await ingestCue(context.db, {
      cue: {
        cueId: cueUnknown,
        source: "test",
        externalEventId: "ev-def-unknown-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: { path: "README.md" },
      },
      sessionId: sessUnknown,
      maxRetries: 3,
    });

    let currentS1 = s1;
    let authS1: AllowedExecutionSafetyState | undefined = undefined;
    while (currentS1.phase !== "CLEAR_WORKING_MEMORY") {
      const step = await advanceCognitiveCycle(
        context.db,
        currentS1.sessionId,
        ports,
        {
          skillKey: "github.contents.read",
          now: T0,
          runtimeAuthorization: authS1,
        },
      );
      authS1 = step.runtimeAuthorization ?? authS1;
      currentS1 = step.nextSession;
      if (step.isBoundary) break;
    }
    expect(currentS1.phase).toBe("CLEAR_WORKING_MEMORY");

    // Corrupt operation to UNKNOWN in DB
    const plan1 = await sessionRepository.findSessionById(
      context.db,
      sessUnknown,
    );
    const execId1 = `exec:${sessUnknown}:${plan1!.currentPlanId}`;
    const opId1 = `op:${execId1}:step-test-1`;
    await context.db
      .update(executionOperations)
      .set({
        status: "UNKNOWN",
        uncertaintyReason: "Simulated corruption",
      })
      .where(eq(executionOperations.operationId, opId1));

    const unknownStepResult = await advanceCognitiveCycle(
      context.db,
      sessUnknown,
      ports,
      { skillKey: "github.contents.read", now: T0 },
    );
    expect(unknownStepResult.cycleResult?.status).toBe("FAILED"); // MUST NOT BE COMPLETED!
    expect(unknownStepResult.cycleResult?.status).not.toBe("COMPLETED");

    // Regression check 2: VERIFIED + execution SUCCEEDED + step PENDING -> NOT COMPLETED (returns FAILED)
    const sessStepPending = "sess-m8104-def-step-pend";
    const cueStepPending = "cue-m8104-def-step-pend";
    const { session: s2 } = await ingestCue(context.db, {
      cue: {
        cueId: cueStepPending,
        source: "test",
        externalEventId: "ev-def-step-pend-1",
        type: "user.action",
        occurredAt: T0,
        receivedAt: T0,
        payload: { path: "README.md" },
      },
      sessionId: sessStepPending,
      maxRetries: 3,
    });

    let currentS2 = s2;
    let authS2: AllowedExecutionSafetyState | undefined = undefined;
    while (currentS2.phase !== "CLEAR_WORKING_MEMORY") {
      const step = await advanceCognitiveCycle(
        context.db,
        currentS2.sessionId,
        ports,
        {
          skillKey: "github.contents.read",
          now: T0,
          runtimeAuthorization: authS2,
        },
      );
      authS2 = step.runtimeAuthorization ?? authS2;
      currentS2 = step.nextSession;
      if (step.isBoundary) break;
    }
    expect(currentS2.phase).toBe("CLEAR_WORKING_MEMORY");

    // Corrupt step status in DB
    const plan2 = await sessionRepository.findSessionById(
      context.db,
      sessStepPending,
    );
    const execId2 = `exec:${sessStepPending}:${plan2!.currentPlanId}`;
    await context.db
      .update(executionStepState)
      .set({
        status: "PENDING",
        startedAt: null,
        completedAt: null,
      })
      .where(eq(executionStepState.executionId, execId2));

    const pendingStepResult = await advanceCognitiveCycle(
      context.db,
      sessStepPending,
      ports,
      { skillKey: "github.contents.read", now: T0 },
    );
    expect(pendingStepResult.cycleResult?.status).toBe("FAILED"); // MUST NOT BE COMPLETED!
    expect(pendingStepResult.cycleResult?.status).not.toBe("COMPLETED");
  });

  // =========================================================================
  // Test L: Provider health route semantics
  // =========================================================================
  it("Test L: Provider health endpoint returns safe unprobed statuses and no exposed secrets", async () => {
    const response = await getHealthRoute();
    expect(response.status).toBe(200);

    const json = (await response.json()) as Record<string, unknown>;
    expect(json.data).toBeDefined();

    const data = json.data as Record<
      string,
      { status: string; provider: string }
    >;
    expect(data.engine.status).toBe("READY");
    expect(data.ollama.status).toBe("NOT_PROBED");
    expect(data.gemini.status).toMatch(/^(CONFIGURED|UNCONFIGURED)$/);
    expect(data.github.status).toMatch(/^(CONFIGURED|UNCONFIGURED)$/);

    // Confirm no secrets or tokens leaked in payload
    const bodyString = JSON.stringify(json);
    expect(bodyString).not.toContain("token");
    expect(bodyString).not.toContain("key");
    expect(bodyString).not.toContain("password");
    expect(bodyString).not.toContain("secret");
  });
});
