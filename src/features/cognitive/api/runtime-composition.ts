import {
  ALLOWED_GITHUB_REPO,
  GitHubReadOnlyAdapter,
} from "../adapters/github/github-adapter";
import type { OperationAdapter } from "../adapters/adapter-contract";
import type { StructuredAiProvider } from "../ai/ai-provider-contract";
import { GeminiStructuredAiProvider } from "../ai/gemini-provider";
import {
  type PerceptionPort,
  type PlanBuilderPort,
  type PlanProposal,
} from "../orchestration/cognitive-ports";
import type {
  AssembledCognitiveContext,
  PerceptionResult,
} from "../orchestration/context-assembler";
import {
  type CognitiveCyclePorts,
  type CognitiveCycleResult,
  runCognitiveCycleUntilBoundary,
} from "../orchestration/cognitive-loop-driver";
import { GeminiCandidateGeneratorPort } from "../orchestration/gemini-candidate-generator";
import {
  GitHubGroundingEvaluator,
  GitHubPolicyEvaluator,
} from "../orchestration/github-grounding-policy";
import { GitHubResultVerifier } from "../orchestration/github-result-verifier";
import { DefaultOperationRequestBuilder } from "../orchestration/operation-request-builder";
import type { PersistedCandidateAction } from "../persistence/contracts/persisted-candidate-action";
import type { PersistedCognitiveSession } from "../persistence/contracts/cognitive-session";
import type { PersistedCueIngress } from "../persistence/contracts/cue-ingress";
import { PersistenceError } from "../persistence/postgres/errors/persistence-errors";
import { sessionRepository } from "../persistence/postgres/repositories/session-repository";
import type { DatabaseClient } from "../persistence/postgres/transactions/transaction-executor";
import type { SupportedTaskProfile } from "./session-run-contracts";

export class ServerPerception implements PerceptionPort {
  async perceive(cue: PersistedCueIngress): Promise<PerceptionResult> {
    const payload = (
      cue.payload && typeof cue.payload === "object" ? cue.payload : {}
    ) as Record<string, unknown>;
    const promptText =
      typeof payload.prompt === "string"
        ? payload.prompt
        : typeof payload.request === "string"
          ? payload.request
          : typeof payload.message === "string"
            ? payload.message
            : cue.source;

    let action =
      typeof payload.requestedAction === "string"
        ? payload.requestedAction
        : typeof payload.action === "string"
          ? payload.action
          : undefined;

    let path = typeof payload.path === "string" ? payload.path : undefined;
    let issueNumber =
      typeof payload.issueNumber === "number" ? payload.issueNumber : undefined;
    let pullNumber =
      typeof payload.pullNumber === "number" ? payload.pullNumber : undefined;
    const state = typeof payload.state === "string" ? payload.state : undefined;
    const perPage =
      typeof payload.perPage === "number" ? payload.perPage : undefined;

    if (!action) {
      if (
        path ||
        /\b(?:file|path|read|inspect|contents?|from|in)\s+([a-zA-Z0-9_./-]+\.[a-zA-Z0-9_-]+)\b/i.test(
          promptText,
        ) ||
        promptText.toLowerCase().includes("readme") ||
        promptText.toLowerCase().includes("package.json")
      ) {
        action = "github.contents.read";
        if (!path) {
          const m =
            promptText.match(
              /\b(?:file|path|read|inspect|contents?|from|in)\s+([a-zA-Z0-9_./-]+\.[a-zA-Z0-9_-]+)\b/i,
            ) ??
            promptText.match(/\b([a-zA-Z0-9_/-]+\.[a-zA-Z0-9_-]+)\b/i);
          path = m
            ? m[1]
            : promptText.toLowerCase().includes("readme")
              ? "README.md"
              : "package.json";
        }
      } else if (
        issueNumber !== undefined ||
        /\b(?:issue\s*(?:#|\s+)?|#)(\d+)\b/i.test(promptText)
      ) {
        action = "github.issue.get";
        if (issueNumber === undefined) {
          const m = promptText.match(/\b(?:issue\s*(?:#|\s+)?|#)(\d+)\b/i);
          issueNumber = m ? parseInt(m[1], 10) : undefined;
        }
      } else if (
        pullNumber !== undefined ||
        /\b(?:pull\s*request|pr)\s*(?:#|\s+)?(\d+)\b/i.test(promptText)
      ) {
        action = "github.pull_request.get";
        if (pullNumber === undefined) {
          const m = promptText.match(/\b(?:pull\s*request|pr)\s*(?:#|\s+)?(\d+)\b/i);
          pullNumber = m ? parseInt(m[1], 10) : undefined;
        }
      } else if (promptText.toLowerCase().includes("issues")) {
        action = "github.issues.list";
      } else if (
        promptText.toLowerCase().includes("pulls") ||
        promptText.toLowerCase().includes("pull requests")
      ) {
        action = "github.pull_requests.list";
      } else {
        action = "github.repo.get";
      }
    }

    return {
      summary: `Perceived task for ${cue.type}: ${cue.source}`,
      structuredFacts: {
        action,
        targetRepo: ALLOWED_GITHUB_REPO,
        ...(path ? { path, requestedFile: path } : {}),
        ...(issueNumber ? { issueNumber } : {}),
        ...(pullNumber ? { pullNumber } : {}),
        ...(state ? { state } : {}),
        ...(perPage ? { perPage } : {}),
      },
      perceivedAt: cue.receivedAt ?? new Date().toISOString(),
    };
  }
}

export class ServerPlanBuilder implements PlanBuilderPort {
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
          stepId: "step-1",
          ordinal: 0,
          description: `Execute read operation ${candidate.action} on ${ALLOWED_GITHUB_REPO}`,
        },
      ],
      dependencies: [],
    };
  }
}

export interface CognitiveRuntimeOptions {
  readonly aiProvider?: StructuredAiProvider;
  readonly adapter?: OperationAdapter;
  readonly fetchFn?: typeof fetch;
  readonly defaultModel?: string;
  readonly defaultTimeoutMs?: number;
}

import { ReliableStructuredAiProvider } from "../ai/reliable-provider";

export function createDefaultCognitivePorts(
  options: CognitiveRuntimeOptions = {},
): CognitiveCyclePorts {
  const rawAiProvider =
    options.aiProvider ??
    new GeminiStructuredAiProvider({
      defaultModel: options.defaultModel ?? "gemini-3.7-flash",
      defaultTimeoutMs: options.defaultTimeoutMs ?? 30_000,
    });
  const aiProvider =
    rawAiProvider instanceof ReliableStructuredAiProvider
      ? rawAiProvider
      : new ReliableStructuredAiProvider(rawAiProvider);

  const adapter =
    options.adapter ??
    new GitHubReadOnlyAdapter({
      fetchFn: options.fetchFn,
      timeoutMs: options.defaultTimeoutMs ?? 15_000,
    });

  return {
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
}

export interface ExecuteCycleOptions {
  readonly taskProfile: SupportedTaskProfile;
  readonly ports?: CognitiveCyclePorts;
  readonly maxTransitions?: number;
  readonly now?: string;
}

export interface ExecuteCycleResult {
  readonly result: CognitiveCycleResult;
  readonly session: PersistedCognitiveSession;
}

export async function executeSessionCycle(
  db: DatabaseClient,
  sessionId: string,
  options: ExecuteCycleOptions,
): Promise<ExecuteCycleResult> {
  const session = await sessionRepository.findSessionById(db, sessionId);
  if (!session) {
    throw PersistenceError.notFound(
      `Cognitive session "${sessionId}" was not found.`,
    );
  }

  // M8.2 Idle Rule: If a session is already IDLE, do not rerun its old cue.
  if (session.phase === "IDLE") {
    return {
      result: {
        status: "NO_ACTION",
        sessionId,
        reason:
          "Session is already in IDLE phase and complete. Create a new cue to start a new task.",
      },
      session,
    };
  }

  const ports = options.ports ?? createDefaultCognitivePorts();
  const maxTransitions = options.maxTransitions ?? 40;

  const result = await runCognitiveCycleUntilBoundary(db, sessionId, ports, {
    skillKey: "github.readonly",
    maxTransitions,
    now: options.now,
  });

  const updatedSession = await sessionRepository.findSessionById(db, sessionId);
  if (!updatedSession) {
    throw PersistenceError.notFound(
      `Cognitive session "${sessionId}" not found after cycle execution.`,
    );
  }

  return {
    result,
    session: updatedSession,
  };
}
