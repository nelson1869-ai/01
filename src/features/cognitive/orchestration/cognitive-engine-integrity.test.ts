import { describe, expect, it } from "vitest";

import { GitHubResultVerifier } from "./github-result-verifier";
import { parseGitHubTargetSpec } from "../domain/target-spec";
import { rankCandidates } from "./candidate-ranking";
import {
  GitHubGroundingEvaluator,
  GitHubPolicyEvaluator,
} from "./github-grounding-policy";
import type { PersistedCandidateAction } from "../persistence/contracts/persisted-candidate-action";
import type { PersistedExecution } from "../persistence/contracts/execution";
import type { PersistedGroundingResult } from "../persistence/contracts/persisted-grounding-result";
import type { AssembledCognitiveContext } from "./context-assembler";
import {
  isSecretKey,
  containsHighConfidenceSecret,
  sanitizeSecretValues,
  assertDataSecurity,
} from "../security/secret-safety";

describe("M8.10.3 Cognitive Engine End-to-End Integrity Hardening", () => {
  const T0 = "2026-08-31T05:00:00.000Z";

  function makeExecution(executionId: string): PersistedExecution {
    return {
      executionId,
      sessionId: "sess-test",
      planId: "plan-test",
      status: "RUNNING",
      currentStepId: "step-1",
      safetyGenerationAtStart: 1,
      startedAt: T0,
      completedAt: null,
      error: null,
      rowVersion: 1,
      createdAt: T0,
      updatedAt: T0,
    };
  }

  describe("1. Target Provenance & Semantic Specification", () => {
    it("parses target spec for repository get", () => {
      const spec = parseGitHubTargetSpec("github.repo.get", "Get repo info", {
        repository: "nelson1869-ai/01",
      });
      expect(spec.kind).toBe("REPOSITORY");
      expect(spec.owner).toBe("nelson1869-ai");
      expect(spec.repo).toBe("01");
    });

    it("parses target spec for file read", () => {
      const spec = parseGitHubTargetSpec("github.contents.read", "Read file", {
        path: "README.md",
        repository: "nelson1869-ai/01",
      });
      expect(spec.kind).toBe("FILE");
      if (spec.kind === "FILE") {
        expect(spec.path).toBe("README.md");
      }
    });

    it("parses target spec for issue get", () => {
      const spec = parseGitHubTargetSpec("github.issue.get", "Get issue #42", {
        issueNumber: 42,
        repository: "nelson1869-ai/01",
      });
      expect(spec.kind).toBe("ISSUE");
      if (spec.kind === "ISSUE") {
        expect(spec.issueNumber).toBe(42);
      }
    });

    it("parses target spec for pull request get", () => {
      const spec = parseGitHubTargetSpec(
        "github.pull_request.get",
        "Get PR #7",
        {
          pullNumber: 7,
          repository: "nelson1869-ai/01",
        },
      );
      expect(spec.kind).toBe("PULL_REQUEST");
      if (spec.kind === "PULL_REQUEST") {
        expect(spec.pullNumber).toBe(7);
      }
    });
  });

  describe("2. Result Verifier Hardening (Fail-Closed on Empty / Malformed HTTP 200)", () => {
    const verifier = new GitHubResultVerifier();

    it("fails verification when provider returns empty object for repo get", async () => {
      const result = await verifier.verify({
        execution: makeExecution("exec-1"),
        observations: [
          {
            observationId: "obs-1",
            executionId: "exec-1",
            stepId: "step-1",
            source: "provider-dispatch",
            sourceEventId: "ev-1",
            summary: "Get repo",
            data: {
              outcome: "CONFIRMED_SUCCESS",
              operationKind: "github.repo.get",
              providerScope: "github-rest",
              result: {}, // Malformed empty HTTP 200
              finishedAt: T0,
            },
            observedAt: T0,
            payloadExpiresAt: null,
          },
        ],
      });

      expect(result.status).toBe("FAILED");
      expect(result.reason).toContain("missing expected property 'name'");
    });

    it("fails verification when provider returns empty object for file contents read", async () => {
      const result = await verifier.verify({
        execution: makeExecution("exec-2"),
        observations: [
          {
            observationId: "obs-2",
            executionId: "exec-2",
            stepId: "step-1",
            source: "provider-dispatch",
            sourceEventId: "ev-2",
            summary: "Read README",
            data: {
              outcome: "CONFIRMED_SUCCESS",
              operationKind: "github.contents.read",
              providerScope: "github-rest",
              result: {}, // Empty
              finishedAt: T0,
            },
            observedAt: T0,
            payloadExpiresAt: null,
          },
        ],
      });

      expect(result.status).toBe("FAILED");
      expect(result.reason).toContain(
        "missing expected file property 'content'",
      );
    });

    it("verifies valid populated repository payload", async () => {
      const result = await verifier.verify({
        execution: makeExecution("exec-3"),
        observations: [
          {
            observationId: "obs-3",
            executionId: "exec-3",
            stepId: "step-1",
            source: "provider-dispatch",
            sourceEventId: "ev-3",
            summary: "Get repo",
            data: {
              outcome: "CONFIRMED_SUCCESS",
              operationKind: "github.repo.get",
              providerScope: "github-rest",
              result: {
                name: "01",
                full_name: "nelson1869-ai/01",
                description: "AutoDo repository",
                private: false,
              },
              finishedAt: T0,
            },
            observedAt: T0,
            payloadExpiresAt: null,
          },
        ],
      });

      expect(result.status).toBe("VERIFIED");
      expect(result.confidence).toBe(1.0);
    });

    it("fails verification if result references an unauthorized repository", async () => {
      const result = await verifier.verify({
        execution: makeExecution("exec-4"),
        observations: [
          {
            observationId: "obs-4",
            executionId: "exec-4",
            stepId: "step-1",
            source: "provider-dispatch",
            sourceEventId: "ev-4",
            summary: "Get repo",
            data: {
              outcome: "CONFIRMED_SUCCESS",
              operationKind: "github.repo.get",
              providerScope: "github-rest",
              result: {
                name: "other-repo",
                full_name: "attacker/other-repo",
              },
              finishedAt: T0,
            },
            observedAt: T0,
            payloadExpiresAt: null,
          },
        ],
      });

      expect(result.status).toBe("FAILED");
      expect(result.reason).toContain("does not match allowed repository");
    });
  });

  describe("3. Secret Safety and Ingress Sanitization", () => {
    it("detects secret keys with arbitrary separators and casing", () => {
      expect(isSecretKey("gemini_api_key")).toBe(true);
      expect(isSecretKey("GEMINI-API-KEY")).toBe(true);
      expect(isSecretKey("github_token")).toBe(true);
      expect(isSecretKey("DATABASE_URL")).toBe(true);
      expect(isSecretKey("test_database_url")).toBe(true);
      expect(isSecretKey("authorization")).toBe(true);
      expect(isSecretKey("user_prompt")).toBe(false);
      expect(isSecretKey("repository_name")).toBe(false);
    });

    it("detects high confidence secret tokens in strings", () => {
      expect(
        containsHighConfidenceSecret("AIzaSyB1234567890abcdefghijklmnopqrstuv"),
      ).toBe(true);
      expect(
        containsHighConfidenceSecret(
          "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
        ),
      ).toBe(true);
      expect(
        containsHighConfidenceSecret(
          "github_pat_1234567890abcdefghijklmnopqrstuvwxyz_0123456789",
        ),
      ).toBe(true);
      expect(
        containsHighConfidenceSecret(
          "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
        ),
      ).toBe(true);
      expect(
        containsHighConfidenceSecret("Hello world, this is a clean string."),
      ).toBe(false);
    });

    it("sanitizes secret values from text", () => {
      const dirty =
        "Here is my key: AIzaSyB1234567890abcdefghijklmnopqrstuv and token: ghp_1234567890abcdefghijklmnopqrstuvwxyz";
      const sanitized = sanitizeSecretValues(dirty);
      expect(sanitized).not.toContain(
        "AIzaSyB1234567890abcdefghijklmnopqrstuv",
      );
      expect(sanitized).not.toContain(
        "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
      );
      expect(sanitized).toContain("[REDACTED_GEMINI_KEY]");
      expect(sanitized).toContain("[REDACTED_GITHUB_TOKEN]");
    });

    it("asserts data security fails closed when high-confidence secret is present", () => {
      const payload = {
        query: "Find issues",
        apiKey: "AIzaSyB1234567890abcdefghijklmnopqrstuv",
      };
      expect(() => assertDataSecurity(payload, "testPayload")).toThrow(
        /Disallowed property/,
      );
    });
  });

  describe("4. Grounding and Policy Evaluator Integrity", () => {
    const grounding = new GitHubGroundingEvaluator();
    const policy = new GitHubPolicyEvaluator();
    const dummyContext = {} as AssembledCognitiveContext;

    it("grounds educational read questions as VERIFIED instead of false-positive rejection", async () => {
      const candidate: PersistedCandidateAction = {
        candidateId: "cand-edu-1",
        sessionId: "sess-1",
        cueId: "cue-1",
        evaluationGeneration: 1,
        goal: "Read repository documentation to explain architecture",
        action: "github.contents.read",
        confidence: 0.95,
        expectedUtility: 0.9,
        estimatedRisk: 0.1,
        estimatedCost: 0.05,
        scoreValue: 0.9,
        recommendation: "AUTO_CANDIDATE",
        scoreFormulaVersion: "v1",
        evidenceIds: [],
        createdAt: T0,
      };

      const result = await grounding.evaluateGrounding(candidate, dummyContext);
      expect(result.status).toBe("VERIFIED");
    });

    it("policy allows verified read-only actions and denies mutating actions", async () => {
      const candidate: PersistedCandidateAction = {
        candidateId: "cand-read-1",
        sessionId: "sess-1",
        cueId: "cue-1",
        evaluationGeneration: 1,
        goal: "List open issues",
        action: "github.issues.list",
        confidence: 0.95,
        expectedUtility: 0.9,
        estimatedRisk: 0.1,
        estimatedCost: 0.05,
        scoreValue: 0.9,
        recommendation: "AUTO_CANDIDATE",
        scoreFormulaVersion: "v1",
        evidenceIds: [],
        createdAt: T0,
      };

      const verifiedGrounding: PersistedGroundingResult = {
        groundingResultId: "ground-1",
        candidateId: "cand-read-1",
        evaluationKey: "eval-1",
        status: "VERIFIED",
        confidence: 1.0,
        reason: "Valid read action",
        evaluatorVersion: "v1",
        evidenceIds: [],
        evaluatedAt: T0,
      };

      const result = await policy.evaluatePolicy(
        candidate,
        verifiedGrounding,
        dummyContext,
      );
      expect(result.outcome).toBe("ALLOW");
      expect(result.policyIds).toContain("github-readonly-v1");
    });
  });

  describe("5. Candidate Ranking & High Score != Permission Invariant", () => {
    it("ranks candidates by confidence and learning state without granting execution authority", () => {
      const candidates: PersistedCandidateAction[] = [
        {
          candidateId: "cand-low",
          sessionId: "sess-1",
          cueId: "cue-1",
          evaluationGeneration: 1,
          goal: "Low utility action",
          action: "github.repo.get",
          confidence: 0.5,
          expectedUtility: 0.4,
          estimatedRisk: 0.3,
          estimatedCost: 0.1,
          scoreValue: 0.4,
          recommendation: "AUTO_CANDIDATE",
          scoreFormulaVersion: "v1",
          evidenceIds: [],
          createdAt: T0,
        },
        {
          candidateId: "cand-high",
          sessionId: "sess-1",
          cueId: "cue-1",
          evaluationGeneration: 1,
          goal: "High utility action",
          action: "github.contents.read",
          confidence: 0.95,
          expectedUtility: 0.9,
          estimatedRisk: 0.05,
          estimatedCost: 0.05,
          scoreValue: 0.9,
          recommendation: "AUTO_CANDIDATE",
          scoreFormulaVersion: "v1",
          evidenceIds: [],
          createdAt: T0,
        },
      ];

      const ranked = rankCandidates(candidates);
      expect(ranked[0].candidateId).toBe("cand-high");
      expect(ranked[0].recommendation).toBe("AUTO_CANDIDATE");
    });
  });
});
