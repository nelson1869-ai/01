import { AiProviderError, type AiErrorCode } from "../ai/ai-errors";
import type { StructuredAiProvider } from "../ai/ai-provider-contract";
import {
  routeTask,
  STATIC_AUTODO_CAPABILITY_RESPONSE,
  type ModelIdentifier,
  type ModelProviderName,
} from "../ai/model-router";
import { SimpleAiTelemetryCollector } from "../ai/reliable-provider";
import {
  type AssistantIntent,
  type AssistantIntentInterpreterPort,
  type AssistantResponseComposerPort,
  type SafeConversationTurn,
  GeminiAssistantIntentInterpreter,
  GeminiAssistantResponseComposer,
} from "./assistant-ai";
import {
  MAX_CONTEXT_CHARACTERS,
  MAX_CONTEXT_TURNS,
  type AssistantChatRequest,
  type AssistantChatResponseData,
  type AssistantModelSelection,
  type AssistantProviderStatus,
} from "./assistant-chat-contracts";
import { assistantConversationRepository } from "../persistence/postgres/repositories/assistant-conversation-repository";
import type {
  AssistantTurnKind,
  AssistantTurnStatus,
  PersistedAssistantTurn,
} from "../persistence/contracts/assistant-conversation";
import type { DatabaseExecutor } from "../persistence/postgres/transactions/transaction-executor";

export type { AssistantTurnKind, AssistantTurnStatus };

const FORBIDDEN_WRITE_PATTERNS: readonly RegExp[] = [
  /\b(delete|remove|drop|destroy)\b/i,
  /\b(create|make|add|post|write|edit|update|modify|change|patch)\b/i,
  /\b(push|commit|merge|rebase|publish|deploy)\b/i,
  /(secret|token|password|credential|api[_-]?key|bearer)/i,
];

export function deterministicDenialReason(message: string): string | null {
  for (const pattern of FORBIDDEN_WRITE_PATTERNS) {
    if (pattern.test(message)) {
      return "I can’t perform that action with the current read-only GitHub policy.";
    }
  }
  return null;
}

export function redactAssistantMessage(text: string): string {
  return text
    .replace(/ghp_[a-zA-Z0-9]{30,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/github_pat_[a-zA-Z0-9_]{30,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/AIzaSy[a-zA-Z0-9_-]{33}/g, "[REDACTED_GEMINI_KEY]")
    .replace(
      /bearer\s+[a-zA-Z0-9._~+/-]+=*/gi,
      "Bearer [REDACTED_AUTH_HEADER]",
    );
}

export interface AssistantConversationStorePort {
  createConversation(
    conversationId: string,
    createdAt: string,
  ): Promise<unknown>;
  beginTurn(input: {
    turnId: string;
    conversationId: string;
    userMessage: string;
    createdAt: string;
  }): Promise<PersistedAssistantTurn>;
  completeTurn(input: {
    turnId: string;
    kind: AssistantTurnKind;
    status: Exclude<AssistantTurnStatus, "PROCESSING">;
    assistantMessage: string;
    decisionSummary: readonly string[];
    cueId?: string | null;
    sessionId?: string | null;
    executionId?: string | null;
    verificationId?: string | null;
    completedAt: string;
  }): Promise<unknown>;
  recentTurns(
    conversationId: string,
    limit: number,
  ): Promise<readonly PersistedAssistantTurn[]>;
}

export interface AssistantToolRunnerPort {
  run(
    intent: AssistantIntent,
    userMessage: string,
    now: string,
  ): Promise<{
    cueId: string | null;
    sessionId: string | null;
    executionId: string | null;
    verificationId: string | null;
    status:
      | "VERIFIED"
      | "FAILED"
      | "INCONCLUSIVE"
      | "UNKNOWN"
      | "RECONCILIATION_REQUIRED"
      | "DENIED";
    verifiedFacts: Readonly<Record<string, unknown>> | null;
  }>;
}

export class DatabaseAssistantConversationStore implements AssistantConversationStorePort {
  constructor(private readonly db: DatabaseExecutor) {}

  createConversation(conversationId: string, createdAt: string) {
    return assistantConversationRepository.createConversation(
      this.db,
      conversationId,
      createdAt,
    );
  }
  beginTurn(input: Parameters<AssistantConversationStorePort["beginTurn"]>[0]) {
    return assistantConversationRepository.beginTurn(this.db, input);
  }
  completeTurn(
    input: Parameters<AssistantConversationStorePort["completeTurn"]>[0],
  ) {
    return assistantConversationRepository.completeTurn(this.db, input);
  }
  recentTurns(conversationId: string, limit: number) {
    return assistantConversationRepository.findRecentCompletedTurns(
      this.db,
      conversationId,
      limit,
    );
  }
}

function boundedContext(
  turns: readonly PersistedAssistantTurn[],
): SafeConversationTurn[] {
  const selected: SafeConversationTurn[] = [];
  let remaining = MAX_CONTEXT_CHARACTERS;
  for (const turn of [...turns].reverse()) {
    if (!turn.assistantMessage || turn.status === "PROCESSING") continue;
    const user = turn.userMessage.slice(0, Math.min(4000, remaining));
    remaining -= user.length;
    if (remaining <= 0) break;
    const assistant = turn.assistantMessage.slice(0, Math.min(4000, remaining));
    remaining -= assistant.length;
    selected.push({
      userMessage: user,
      assistantMessage: assistant,
      verification:
        turn.kind === "DIRECT_ANSWER"
          ? "NOT_REQUIRED"
          : turn.status === "COMPLETED" && turn.verificationId
            ? "VERIFIED"
            : "UNVERIFIED",
    });
    if (selected.length >= MAX_CONTEXT_TURNS || remaining <= 0) break;
  }
  return selected.reverse();
}

function safeProviderFailure(error: unknown): {
  readonly providerStatus: AssistantProviderStatus;
  readonly summary: string;
} {
  const code =
    error instanceof AiProviderError ? error.code : "UNKNOWN_PROVIDER_FAILURE";
  const p =
    error instanceof AiProviderError && error.provider === "ollama"
      ? "Ollama"
      : "Gemini";
  const summaries: Record<AiErrorCode, string> = {
    MISSING_CREDENTIAL: `The ${p} provider is not configured with a credential.`,
    AUTHENTICATION_FAILED: `The ${p} provider could not authenticate.`,
    RATE_LIMITED: `The ${p} provider is currently rate limited.`,
    TIMEOUT: `The ${p} provider timed out.`,
    PROVIDER_UNAVAILABLE: `The ${p} provider is currently unavailable.`,
    SAFETY_BLOCKED: `The ${p} provider blocked the request through its safety controls.`,
    INVALID_STRUCTURED_OUTPUT: `The ${p} provider returned an invalid structured response.`,
    RESPONSE_TOO_LARGE: `The ${p} provider response exceeded the safe size limit.`,
    UNKNOWN_PROVIDER_FAILURE:
      "The assistant encountered an unknown provider failure.",
  };
  return {
    providerStatus: code,
    summary: summaries[code],
  };
}

export function isCrossProviderFallbackEligible(error: unknown): boolean {
  if (error instanceof AiProviderError) {
    if (error.code === "SAFETY_BLOCKED") {
      return false;
    }
    return (
      error.code === "TIMEOUT" ||
      error.code === "RATE_LIMITED" ||
      error.code === "PROVIDER_UNAVAILABLE" ||
      error.code === "MISSING_CREDENTIAL" ||
      error.code === "INVALID_STRUCTURED_OUTPUT"
    );
  }
  return false;
}

export interface AssistantChatServiceDependencies {
  readonly store: AssistantConversationStorePort;
  readonly toolRunner: AssistantToolRunnerPort;
  readonly providers?: Partial<Record<ModelProviderName, StructuredAiProvider>>;
  readonly interpreter?: AssistantIntentInterpreterPort;
  readonly composer?: AssistantResponseComposerPort;
  readonly fallbackInterpreter?: AssistantIntentInterpreterPort;
  readonly fallbackComposer?: AssistantResponseComposerPort;
  readonly now?: () => string;
}

export class AssistantChatService {
  constructor(
    private readonly dependencies: AssistantChatServiceDependencies,
  ) {}

  private getInterpreter(
    provider: ModelProviderName,
  ): AssistantIntentInterpreterPort {
    const p = this.dependencies.providers?.[provider];
    if (p) {
      return new GeminiAssistantIntentInterpreter(p);
    }
    if (provider === "ollama" && this.dependencies.fallbackInterpreter) {
      return (
        this.dependencies.interpreter ?? this.dependencies.fallbackInterpreter
      );
    }
    return this.dependencies.interpreter!;
  }

  private getComposer(
    provider: ModelProviderName,
  ): AssistantResponseComposerPort {
    const p = this.dependencies.providers?.[provider];
    if (p) {
      return new GeminiAssistantResponseComposer(p);
    }
    if (provider === "ollama" && this.dependencies.fallbackComposer) {
      return this.dependencies.composer ?? this.dependencies.fallbackComposer;
    }
    return this.dependencies.composer!;
  }

  async chat(
    request: AssistantChatRequest,
  ): Promise<AssistantChatResponseData> {
    const startTime = Date.now();
    const telemetryCollector = new SimpleAiTelemetryCollector();
    const now = this.dependencies.now?.() ?? new Date().toISOString();
    const conversationId =
      request.conversationId ?? `conv-${crypto.randomUUID()}`;
    if (!request.conversationId) {
      await this.dependencies.store.createConversation(conversationId, now);
    }
    const sanitizedMessage = redactAssistantMessage(request.message);
    const priorTurns = await this.dependencies.store.recentTurns(
      conversationId,
      MAX_CONTEXT_TURNS,
    );
    const context = boundedContext(priorTurns);
    const turn = await this.dependencies.store.beginTurn({
      turnId: `turn-${crypto.randomUUID()}`,
      conversationId,
      userMessage: sanitizedMessage,
      createdAt: now,
    });

    const routeDecision = routeTask(sanitizedMessage);
    let activeProvider: ModelProviderName = routeDecision.selectedProvider;
    let activeModel: ModelIdentifier = routeDecision.selectedModel;
    let fallbackUsed = false;

    let externalActionAttempted = false;
    let completedTool: Awaited<
      ReturnType<AssistantToolRunnerPort["run"]>
    > | null = null;

    const finish = async (input: {
      kind: AssistantTurnKind;
      status: Exclude<AssistantTurnStatus, "PROCESSING">;
      message: string;
      verification: AssistantChatResponseData["verification"];
      providerStatus?: AssistantProviderStatus | null;
      decisionSummary: readonly string[];
      modelSelection?: AssistantModelSelection;
      cueId?: string | null;
      sessionId?: string | null;
      executionId?: string | null;
      verificationId?: string | null;
    }): Promise<AssistantChatResponseData> => {
      const safeMessage = redactAssistantMessage(input.message).slice(0, 12000);
      await this.dependencies.store.completeTurn({
        turnId: turn.turnId,
        kind: input.kind,
        status: input.status,
        assistantMessage: safeMessage,
        decisionSummary: input.decisionSummary,
        cueId: input.cueId,
        sessionId: input.sessionId,
        executionId: input.executionId,
        verificationId: input.verificationId,
        completedAt: now,
      });
      const totalDurationMs = Date.now() - startTime;
      const modelSelection: AssistantModelSelection = input.modelSelection ?? {
        provider: activeProvider,
        model: activeModel,
        fallbackUsed,
        taskClass: routeDecision.taskClass,
        reasonCode: routeDecision.reasonCode,
      };

      return {
        conversationId,
        message: safeMessage,
        status:
          input.status === "CLARIFICATION_REQUIRED"
            ? "CLARIFICATION_REQUIRED"
            : input.status,
        providerStatus: input.providerStatus ?? null,
        modelSelection,
        sessionId: input.sessionId ?? null,
        executionId: input.executionId ?? null,
        verification: input.verification,
        decisionSummary: input.decisionSummary,
        telemetry: {
          totalDurationMs,
          ai: telemetryCollector.getStages(),
        },
      };
    };

    // 1. Zero-Model Fast Path for static capability / greetings
    if (routeDecision.taskClass === "STATIC_CAPABILITY") {
      return finish({
        kind: "DIRECT_ANSWER",
        status: "COMPLETED",
        message: STATIC_AUTODO_CAPABILITY_RESPONSE,
        verification: "NOT_REQUIRED",
        decisionSummary: [
          "Static AutoDo capability fast path was matched.",
          "No external action was performed.",
        ],
        modelSelection: {
          provider: "autodo",
          model: "deterministic",
          fallbackUsed: false,
          taskClass: "STATIC_CAPABILITY",
          reasonCode: "STATIC_CAPABILITY",
        },
      });
    }

    // 2. Deterministic Denial
    const denial = deterministicDenialReason(sanitizedMessage);
    if (denial) {
      return finish({
        kind: "DENIED",
        status: "DENIED",
        message: denial,
        verification: "NOT_REQUIRED",
        decisionSummary: [
          "The request conflicts with the read-only policy.",
          "No external action was performed.",
        ],
        modelSelection: {
          provider: "autodo",
          model: "deterministic",
          fallbackUsed: false,
          taskClass: routeDecision.taskClass,
          reasonCode: "DETERMINISTIC_DENIAL",
        },
      });
    }

    try {
      // 3. Ingress Intent Interpretation (with fallback)
      let intent: AssistantIntent;
      try {
        const primaryInterpreter = this.getInterpreter(
          routeDecision.selectedProvider,
        );
        intent = await primaryInterpreter.interpret(sanitizedMessage, context, {
          telemetryCollector,
          model: routeDecision.selectedModel,
        });
      } catch (interpreterError: unknown) {
        if (
          isCrossProviderFallbackEligible(interpreterError) &&
          routeDecision.fallbackChain.length > 0
        ) {
          const fallback = routeDecision.fallbackChain[0];
          fallbackUsed = true;
          activeProvider = fallback.provider;
          activeModel = fallback.model;
          const fallbackInterpreter = this.getInterpreter(fallback.provider);
          intent = await fallbackInterpreter.interpret(
            sanitizedMessage,
            context,
            {
              telemetryCollector,
              model: fallback.model,
            },
          );
        } else {
          throw interpreterError;
        }
      }

      if (intent.kind === "DENIED") {
        return finish({
          kind: "DENIED",
          status: "DENIED",
          message: intent.response ?? "I can’t safely perform that request.",
          verification: "NOT_REQUIRED",
          decisionSummary: [
            "The request is not permitted by the current policy.",
            "No external action was performed.",
          ],
        });
      }
      if (intent.kind === "CLARIFICATION") {
        return finish({
          kind: "CLARIFICATION",
          status: "CLARIFICATION_REQUIRED",
          message:
            intent.response ??
            "I need more information before I can safely do that.",
          verification: "NOT_REQUIRED",
          decisionSummary: [
            "The request has more than one safe interpretation.",
            "No external action was performed.",
          ],
        });
      }
      if (intent.kind === "DIRECT_ANSWER") {
        let message: string;
        try {
          const primaryComposer = this.getComposer(activeProvider);
          message = await primaryComposer.composeDirect(
            sanitizedMessage,
            context,
            {
              telemetryCollector,
              model: activeModel,
            },
          );
        } catch (composerError: unknown) {
          if (
            !fallbackUsed &&
            isCrossProviderFallbackEligible(composerError) &&
            routeDecision.fallbackChain.length > 0
          ) {
            const fallback = routeDecision.fallbackChain[0];
            fallbackUsed = true;
            activeProvider = fallback.provider;
            activeModel = fallback.model;
            const fallbackComposer = this.getComposer(fallback.provider);
            message = await fallbackComposer.composeDirect(
              sanitizedMessage,
              context,
              {
                telemetryCollector,
                model: fallback.model,
              },
            );
          } else {
            throw composerError;
          }
        }

        return finish({
          kind: "DIRECT_ANSWER",
          status: "COMPLETED",
          message,
          verification: "NOT_REQUIRED",
          decisionSummary: [
            "The request does not require current external information.",
            "No external action was performed.",
          ],
        });
      }

      // 4. Tool Execution (Grounding, Policy, Auth, Adapter, Observation, Verification)
      externalActionAttempted = true;
      const tool = await this.dependencies.toolRunner.run(
        intent,
        sanitizedMessage,
        now,
      );
      completedTool = tool;
      const links = {
        cueId: tool.cueId,
        sessionId: tool.sessionId,
        executionId: tool.executionId,
        verificationId: tool.verificationId,
      };

      if (tool.status === "VERIFIED" && tool.verifiedFacts) {
        let message: string;
        try {
          const primaryComposer = this.getComposer(activeProvider);
          message = await primaryComposer.composeVerified({
            message: sanitizedMessage,
            context,
            verifiedFacts: tool.verifiedFacts,
            options: {
              telemetryCollector,
              model: activeModel,
            },
          });
        } catch (composerError: unknown) {
          if (
            !fallbackUsed &&
            isCrossProviderFallbackEligible(composerError) &&
            routeDecision.fallbackChain.length > 0
          ) {
            const fallback = routeDecision.fallbackChain[0];
            fallbackUsed = true;
            activeProvider = fallback.provider;
            activeModel = fallback.model;
            const fallbackComposer = this.getComposer(fallback.provider);
            message = await fallbackComposer.composeVerified({
              message: sanitizedMessage,
              context,
              verifiedFacts: tool.verifiedFacts,
              options: {
                telemetryCollector,
                model: fallback.model,
              },
            });
          } else {
            throw composerError;
          }
        }

        return finish({
          ...links,
          kind: "TOOL_REQUIRED",
          status: "COMPLETED",
          message,
          verification: "VERIFIED",
          decisionSummary: [
            "The request requires current repository information.",
            "GitHub read access is allowed.",
            "The provider result was deterministically verified before answering.",
          ],
        });
      }
      if (tool.status === "DENIED") {
        return finish({
          ...links,
          kind: "TOOL_REQUIRED",
          status: "DENIED",
          message:
            "I can’t perform that action with the current read-only GitHub policy.",
          verification: "NOT_REQUIRED",
          decisionSummary: [
            "The existing grounding or policy boundary did not authorize the action.",
            "No provider result was presented as fact.",
          ],
        });
      }
      const verification =
        tool.status === "RECONCILIATION_REQUIRED"
          ? "RECONCILIATION_REQUIRED"
          : tool.status;
      return finish({
        ...links,
        kind: "TOOL_REQUIRED",
        status: "UNVERIFIED",
        message: "I couldn’t verify that result yet.",
        verification,
        decisionSummary: [
          "The tool result was not verified.",
          "No unverified provider content was presented as fact.",
        ],
      });
    } catch (error) {
      const failure = safeProviderFailure(error);
      return finish({
        kind: "DIRECT_ANSWER",
        status: "FAILED",
        message: "I couldn’t complete that request safely.",
        providerStatus: failure.providerStatus,
        verification: "UNKNOWN",
        cueId: completedTool?.cueId,
        sessionId: completedTool?.sessionId,
        executionId: completedTool?.executionId,
        verificationId: completedTool?.verificationId,
        decisionSummary: [
          failure.summary,
          externalActionAttempted
            ? "No unverified provider result was presented as fact."
            : "No external action was performed.",
        ],
      });
    }
  }
}
