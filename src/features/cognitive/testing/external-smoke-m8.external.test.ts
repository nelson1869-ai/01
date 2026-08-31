import { describe, expect, it } from "vitest";
import { ALLOWED_GITHUB_REPO, GitHubReadOnlyAdapter } from "../adapters/github/github-adapter";
import { GeminiStructuredAiProvider } from "../ai/gemini-provider";
import { executeSessionCycle, ServerPerception, ServerPlanBuilder } from "../api/runtime-composition";
import { GeminiCandidateGeneratorPort } from "../orchestration/gemini-candidate-generator";
import { GitHubGroundingEvaluator, GitHubPolicyEvaluator } from "../orchestration/github-grounding-policy";
import { GitHubResultVerifier } from "../orchestration/github-result-verifier";
import { DefaultOperationRequestBuilder } from "../orchestration/operation-request-builder";
import type { CognitiveCyclePorts } from "../orchestration/cognitive-loop-driver";
import { setupIntegrationTestDatabase, cleanIntegrationTestTables } from "../persistence/postgres/testing/integration-harness";
import { ingestCue } from "../persistence/postgres/transactions/ingest-cue";

describe("Opt-in Real External Smoke Tests for Milestone 8 (Full M8 End-to-End)", () => {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const githubToken = process.env.GITHUB_TOKEN;

  it("Full real end-to-end M8 cognitive cycle against real Gemini & real GitHub Read", async () => {
    if (!geminiApiKey || !githubToken) {
      const missing = [];
      if (!geminiApiKey) missing.push("GEMINI_API_KEY");
      if (!githubToken) missing.push("GITHUB_TOKEN");
      console.log(`SKIPPED: Missing external environment variables: ${missing.join(", ")}.`);
      return;
    }

    const context = await setupIntegrationTestDatabase();
    try {
      await cleanIntegrationTestTables(context.db);

      const now = new Date().toISOString();
      const { session } = await ingestCue(context.db, {
        cue: {
          cueId: "cue-smoke-m8-e2e",
          source: "postman-smoke",
          externalEventId: "evt-smoke-m8-e2e",
          type: "user.action",
          occurredAt: now,
          receivedAt: now,
          payload: { instruction: "Read README.md from repository" },
        },
        sessionId: "sess-smoke-m8-e2e",
      });

      const aiProvider = new GeminiStructuredAiProvider({ apiKey: geminiApiKey });
      const adapter = new GitHubReadOnlyAdapter({ token: githubToken });

      const ports: CognitiveCyclePorts = {
        perception: new ServerPerception(),
        candidateGenerator: new GeminiCandidateGeneratorPort(aiProvider, {
          defaultRepository: ALLOWED_GITHUB_REPO,
        }),
        groundingEvaluator: new GitHubGroundingEvaluator(),
        policyEvaluator: new GitHubPolicyEvaluator(),
        planBuilder: new ServerPlanBuilder(),
        requestBuilder: new DefaultOperationRequestBuilder(),
        adapter,
        verifier: new GitHubResultVerifier(),
      };

      const outcome = await executeSessionCycle(context.db, session.sessionId, {
        taskProfile: "github-readonly-v1",
        ports,
      });

      console.log(`[M8 External Smoke] Cycle Outcome Status: ${outcome.result.status}, Session Phase: ${outcome.session.phase}`);
      expect(outcome.result.status).toBe("COMPLETED");
      expect(outcome.session.phase).toBe("IDLE");
    } finally {
      await context.close();
    }
  });
});
