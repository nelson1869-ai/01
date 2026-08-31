import type { OperationAdapter } from "../adapters/adapter-contract";
import { ALLOWED_GITHUB_REPO } from "../adapters/github/github-adapter";
import type { ResultVerifier } from "../domain/verifier-contract";
import type {
  CandidateGeneratorPort,
  PerceptionPort,
} from "../orchestration/cognitive-ports";
import type { CognitiveCyclePorts } from "../orchestration/cognitive-loop-driver";
import type { PerceptionResult } from "../orchestration/context-assembler";
import { createCanonicalFingerprint } from "../persistence/postgres/utils/canonical-fingerprint";
import type { PersistedCueIngress } from "../persistence/contracts/cue-ingress";
import type { DatabaseClient } from "../persistence/postgres/transactions/transaction-executor";
import { ingestCue } from "../persistence/postgres/transactions/ingest-cue";
import { observationRepository } from "../persistence/postgres/repositories/observation-repository";
import { verificationRepository } from "../persistence/postgres/repositories/verification-repository";
import type { AssistantIntent } from "./assistant-ai";
import {
  createDefaultCognitivePorts,
  executeSessionCycle,
} from "./runtime-composition";
import type {
  BuiltOperationRequest,
  OperationRequestBuilderPort,
} from "../orchestration/operation-request-builder";
import type { PersistedCandidateAction } from "../persistence/contracts/persisted-candidate-action";
import type { PersistedActionPlan } from "../persistence/contracts/persisted-action-plan";
import type { PlanStepProposal } from "../orchestration/cognitive-ports";

import type { AssistantProgressStage } from "./assistant-progress";

export interface AssistantToolRunResult {
  readonly status:
    | "VERIFIED"
    | "FAILED"
    | "INCONCLUSIVE"
    | "UNKNOWN"
    | "RECONCILIATION_REQUIRED"
    | "DENIED";
  readonly sessionId: string;
  readonly cueId: string;
  readonly executionId: string | null;
  readonly verificationId: string | null;
  readonly verifiedFacts: Readonly<Record<string, unknown>> | null;
  readonly reason: string;
}

export interface AssistantToolRunnerPort {
  run(
    intent: AssistantIntent,
    sanitizedMessage: string,
    now: string,
    options?: {
      readonly onStage?: (
        stage: AssistantProgressStage,
      ) => void | Promise<void>;
      readonly signal?: AbortSignal;
    },
  ): Promise<AssistantToolRunResult>;
}

class AssistantPerception implements PerceptionPort {
  constructor(private readonly intent: AssistantIntent) {}
  async perceive(cue: PersistedCueIngress): Promise<PerceptionResult> {
    return {
      summary: `Assistant requested ${this.intent.action ?? "no operation"} on the locked repository.`,
      structuredFacts: {
        targetRepo: ALLOWED_GITHUB_REPO,
        requestedFile: this.intent.path ?? "README.md",
        issueNumber: this.intent.issueNumber,
        pullNumber: this.intent.pullNumber,
      },
      perceivedAt: cue.receivedAt,
    };
  }
}

class AssistantCandidateGenerator implements CandidateGeneratorPort {
  constructor(private readonly intent: AssistantIntent) {}
  async generateCandidates(
    context: Parameters<CandidateGeneratorPort["generateCandidates"]>[0],
  ) {
    if (this.intent.kind !== "TOOL_REQUIRED" || !this.intent.action) return [];
    return [
      {
        candidateId: `cand:${context.cue.cueId}:assistant`,
        cueId: context.cue.cueId,
        goal: this.intent.goal,
        action: this.intent.action,
        confidence: 0.95,
        expectedUtility: 0.9,
        estimatedRisk: 0.05,
        estimatedCost: 0.05,
        evidenceIds: [],
      },
    ];
  }
}

class AssistantOperationRequestBuilder implements OperationRequestBuilderPort {
  constructor(private readonly intent: AssistantIntent) {}
  buildOperationRequest(
    candidate: PersistedCandidateAction,
    _plan: PersistedActionPlan,
    _step: PlanStepProposal,
  ): BuiltOperationRequest {
    void _plan;
    void _step;
    const operationKind = candidate.action;
    const request: Record<string, unknown> = {
      repository: ALLOWED_GITHUB_REPO,
    };
    if (operationKind === "github.contents.read") {
      request.path = this.intent.path ?? "README.md";
      request.ref = "main";
    } else if (operationKind === "github.issue.get") {
      request.issueNumber = this.intent.issueNumber ?? 1;
    } else if (operationKind === "github.pull_request.get") {
      request.pullNumber = this.intent.pullNumber ?? 1;
    } else if (
      operationKind === "github.issues.list" ||
      operationKind === "github.pull_requests.list"
    ) {
      request.state = "open";
      request.perPage = 10;
    }
    return {
      operationKind,
      providerScope: "github-rest",
      request,
      requestFingerprint: createCanonicalFingerprint({
        operationKind,
        providerScope: "github-rest",
        request,
      }),
      providerIdempotencyKey: null,
    };
  }
}

function boundedProviderValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]";
  if (typeof value === "string") return value.slice(0, 8000);
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return value;
  if (Array.isArray(value))
    return value
      .slice(0, 50)
      .map((item) => boundedProviderValue(item, depth + 1));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value).slice(0, 50)) {
      if (/token|authorization|credential|secret|api.?key/i.test(key)) continue;
      result[key] = boundedProviderValue(child, depth + 1);
    }
    return result;
  }
  return String(value).slice(0, 1000);
}

export interface DatabaseAssistantToolRunnerOptions {
  readonly adapter?: OperationAdapter;
  readonly verifier?: ResultVerifier;
  readonly ports?: CognitiveCyclePorts;
}

export class DatabaseAssistantToolRunner implements AssistantToolRunnerPort {
  constructor(
    private readonly db: DatabaseClient,
    private readonly options: DatabaseAssistantToolRunnerOptions = {},
  ) {}

  async run(
    intent: AssistantIntent,
    sanitizedMessage: string,
    now: string,
    options?: {
      readonly onStage?: (
        stage: AssistantProgressStage,
      ) => void | Promise<void>;
      readonly signal?: AbortSignal;
    },
  ): Promise<AssistantToolRunResult> {
    if (intent.kind !== "TOOL_REQUIRED" || !intent.action) {
      throw new Error(
        "Assistant tool runner requires a read-only tool intent.",
      );
    }
    await options?.onStage?.("SAFETY_CHECK");
    const cueId = `cue-${crypto.randomUUID()}`;
    const sessionId = `sess-${crypto.randomUUID()}`;
    const cue: PersistedCueIngress = {
      cueId,
      source: "assistant.chat",
      externalEventId: `assistant-turn-${crypto.randomUUID()}`,
      type: "user.action",
      occurredAt: now,
      receivedAt: now,
      payload: {
        message: sanitizedMessage,
        requestedAction: intent.action,
        path: intent.path,
        issueNumber: intent.issueNumber,
        pullNumber: intent.pullNumber,
      },
    };
    await ingestCue(this.db, { cue, sessionId, maxRetries: 0 });

    await options?.onStage?.("PLANNING");
    const defaults =
      this.options.ports ??
      createDefaultCognitivePorts({ adapter: this.options.adapter });
    const ports: CognitiveCyclePorts = {
      ...defaults,
      perception: new AssistantPerception(intent),
      candidateGenerator: new AssistantCandidateGenerator(intent),
      requestBuilder: new AssistantOperationRequestBuilder(intent),
      ...(this.options.verifier ? { verifier: this.options.verifier } : {}),
    };

    await options?.onStage?.("TOOL_EXECUTION");
    const outcome = await executeSessionCycle(this.db, sessionId, {
      taskProfile: "github-readonly-v1",
      ports,
      now,
    });
    const cycle = outcome.result;
    if (cycle.status === "RECONCILIATION_REQUIRED") {
      return {
        status: "RECONCILIATION_REQUIRED",
        sessionId,
        cueId,
        executionId: cycle.executionId,
        verificationId: null,
        verifiedFacts: null,
        reason: cycle.reason,
      };
    }
    if (
      cycle.status === "HUMAN_REVIEW_REQUIRED" ||
      cycle.status === "BLOCKED" ||
      cycle.status === "NO_ACTION"
    ) {
      return {
        status: "DENIED",
        sessionId,
        cueId,
        executionId: null,
        verificationId: null,
        verifiedFacts: null,
        reason: cycle.reason,
      };
    }
    const executionId =
      "executionId" in cycle ? (cycle.executionId ?? null) : null;
    if (!executionId) {
      return {
        status: "UNKNOWN",
        sessionId,
        cueId,
        executionId: null,
        verificationId: null,
        verifiedFacts: null,
        reason: "The tool result did not include an execution identifier.",
      };
    }

    await options?.onStage?.("OBSERVING");
    await options?.onStage?.("VERIFYING");
    const verification =
      await verificationRepository.findLatestVerificationByExecutionId(
        this.db,
        executionId,
      );
    if (!verification) {
      return {
        status: "UNKNOWN",
        sessionId,
        cueId,
        executionId,
        verificationId: null,
        verifiedFacts: null,
        reason: "No durable result verification was found.",
      };
    }
    if (verification.status !== "VERIFIED") {
      return {
        status: verification.status,
        sessionId,
        cueId,
        executionId,
        verificationId: verification.verificationId,
        verifiedFacts: null,
        reason: verification.reason,
      };
    }
    const observations =
      await observationRepository.findManyObservationsByExecutionId(
        this.db,
        executionId,
      );
    const facts =
      observations[0]?.data && typeof observations[0].data === "object"
        ? (observations[0].data as Record<string, unknown>).result
        : null;
    return {
      status: "VERIFIED",
      sessionId,
      cueId,
      executionId,
      verificationId: verification.verificationId,
      verifiedFacts: (boundedProviderValue(facts ?? {}) ?? {}) as Readonly<
        Record<string, unknown>
      >,
      reason: verification.reason,
    };
  }
}
