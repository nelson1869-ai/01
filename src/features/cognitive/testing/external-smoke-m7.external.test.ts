import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ALLOWED_GITHUB_REPO,
  GitHubReadOnlyAdapter,
} from "../adapters/github/github-adapter";
import { GeminiStructuredAiProvider } from "../ai/gemini-provider";
import { GeminiCandidateGeneratorPort } from "../orchestration/gemini-candidate-generator";

describe("Opt-in Real External Smoke Tests for Milestone 7 (Gemini + GitHub)", () => {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const githubToken = process.env.GITHUB_TOKEN;

  it("A. Real Gemini 3.7 Flash structured-output connectivity smoke", async () => {
    if (!geminiApiKey) {
      console.log("SKIPPED: GEMINI_API_KEY is not set in environment.");
      return;
    }

    const provider = new GeminiStructuredAiProvider({ apiKey: geminiApiKey });
    const startTime = Date.now();

    const result = await provider.generateStructured({
      taskName: "smoke-connectivity",
      systemInstruction: "You are a calculator. Return valid JSON only.",
      prompt: "Calculate 2 + 2 and explain briefly in one word.",
      schema: z.object({
        calculation: z.number(),
        word: z.string(),
      }),
      timeoutMs: 30000,
    });

    const durationMs = Date.now() - startTime;
    console.log(
      `[Gemini Smoke] Model: ${result.model}, Latency: ${durationMs}ms, Value: ${JSON.stringify(result.value)}`,
    );

    expect(result.provider).toBe("gemini");
    expect(result.model).toBe("gemini-3.7-flash");
    expect(result.value.calculation).toBe(4);
    expect(typeof result.value.word).toBe("string");
  });

  it("B. Real GitHub READ-ONLY connectivity smoke on nelson1869-ai/01", async () => {
    if (!githubToken) {
      console.log("SKIPPED: GITHUB_TOKEN is not set in environment.");
      return;
    }

    const adapter = new GitHubReadOnlyAdapter({ token: githubToken });
    const startTime = Date.now();

    // 1. Read repository metadata (GET only)
    const repoResult = await adapter.dispatch({
      operationId: "smoke-gh-repo-1",
      operationKind: "github.repo.get",
      operationGeneration: 1,
      attemptNumber: 1,
      idempotencyKey: "idemp-smoke-repo",
      providerScope: "github-rest",
      providerIdempotencyKey: null,
      request: { repository: ALLOWED_GITHUB_REPO },
    });

    const durationMs = Date.now() - startTime;
    console.log(
      `[GitHub Smoke] Repo: ${ALLOWED_GITHUB_REPO}, Outcome: ${repoResult.outcome}, Latency: ${durationMs}ms`,
    );

    expect(repoResult.outcome).toBe("CONFIRMED_SUCCESS");
    if (repoResult.outcome === "CONFIRMED_SUCCESS") {
      expect(repoResult.result.fullName).toBe(ALLOWED_GITHUB_REPO);
      expect(repoResult.metadata?.provider).toBe("github-rest");
    }

    // 2. Read README.md file (GET only)
    const contentsResult = await adapter.dispatch({
      operationId: "smoke-gh-contents-1",
      operationKind: "github.contents.read",
      operationGeneration: 1,
      attemptNumber: 1,
      idempotencyKey: "idemp-smoke-contents",
      providerScope: "github-rest",
      providerIdempotencyKey: null,
      request: { repository: ALLOWED_GITHUB_REPO, path: "README.md" },
    });

    expect(contentsResult.outcome).toBe("CONFIRMED_SUCCESS");
    if (contentsResult.outcome === "CONFIRMED_SUCCESS") {
      expect(contentsResult.result.repository).toBe(ALLOWED_GITHUB_REPO);
      expect(contentsResult.result.path).toBe("README.md");
      expect(typeof contentsResult.result.content).toBe("string");
    }
  });

  it("C. Real Gemini candidate generator proposal smoke", async () => {
    if (!geminiApiKey) {
      console.log("SKIPPED: GEMINI_API_KEY is not set in environment.");
      return;
    }

    const provider = new GeminiStructuredAiProvider({ apiKey: geminiApiKey });
    const generator = new GeminiCandidateGeneratorPort(provider);

    const dummyContext = {
      cue: {
        cueId: "smoke-cue-1",
        source: "github-webhook",
        externalEventId: "ev-smoke-1",
        type: "user.action" as const,
        occurredAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        payload: { request: "Check open issues in repository" },
      },
      session: {
        sessionId: "smoke-session-1",
        cueId: "smoke-cue-1",
        phase: "GENERATE_CANDIDATES" as const,
        failureCount: 0,
        retryCount: 0,
        maxRetries: 3,
        evaluationGeneration: 1,
        cooldownUntil: null,
        currentCandidateId: null,
        currentPlanId: null,
        currentExecutionId: null,
        rowVersion: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      perception: {
        summary: "User requested checking open issues.",
        structuredFacts: {
          task: "github.issues.list",
          repository: ALLOWED_GITHUB_REPO,
        },
        perceivedAt: new Date().toISOString(),
      },
      targetSpec: {
        kind: "ISSUE_LIST" as const,
        repository: ALLOWED_GITHUB_REPO,
        owner: "nelson1869-ai",
        repo: "01",
        state: "open" as const,
        perPage: 30,
      },
      verifiedMemories: [],
      learningState: {
        skillKey: "github.issues.list",
        confidence: 0.9,
        totalReward: 100,
        sampleCount: 20,
        rowVersion: 0,
        updatedAt: new Date().toISOString(),
      },
      metadata: {},
    };

    const candidates = await generator.generateCandidates(dummyContext);
    console.log(
      `[Gemini Proposal Smoke] Generated ${candidates.length} candidate(s): ${candidates.map((c) => c.action).join(", ")}`,
    );

    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates.length).toBeLessThanOrEqual(5);
    for (const c of candidates) {
      expect([
        "github.repo.get",
        "github.contents.read",
        "github.issues.list",
        "github.issue.get",
        "github.pull_requests.list",
        "github.pull_request.get",
      ]).toContain(c.action);
    }
  });
});
