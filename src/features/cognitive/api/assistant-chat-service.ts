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
import {
  type AssistantProgressSink,
  type AssistantProgressStage,
  NoopAssistantProgressSink,
  ProgressEmitter,
  safeModelSelectedMessage,
  safeRetryMessage,
  safeToolExecutionMessage,
} from "./assistant-progress";
import {
  deterministicDenialReason,
  redactAssistantMessage,
} from "./assistant-security";

export { deterministicDenialReason, redactAssistantMessage };
export type { AssistantTurnKind, AssistantTurnStatus };

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
    options?: {
      readonly onStage?: (
        stage: AssistantProgressStage,
      ) => void | Promise<void>;
      readonly signal?: AbortSignal;
    },
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
    reason?: string;
  }>;
}

export type { AssistantToolRunResult } from "./assistant-tool-runtime";

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
): readonly SafeConversationTurn[] {
  let remaining = MAX_CONTEXT_CHARACTERS;
  const selected: SafeConversationTurn[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.status === "PROCESSING" || turn.status === "FAILED") {
      continue;
    }
    const user = turn.userMessage.slice(0, remaining);
    remaining -= user.length;
    const assistant = (turn.assistantMessage ?? "").slice(0, remaining);
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

export function isCrossProviderFallbackEligible(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  if (signal?.aborted) {
    return false;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return false;
  }
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
  readonly interpreter?: AssistantIntentInterpreterPort;
  readonly composer?: AssistantResponseComposerPort;
  readonly fallbackInterpreter?: AssistantIntentInterpreterPort;
  readonly fallbackComposer?: AssistantResponseComposerPort;
  readonly toolRunner: AssistantToolRunnerPort;
  readonly providers?: Partial<Record<ModelProviderName, StructuredAiProvider>>;
  readonly now?: () => string;
}

export interface AssistantChatOptions {
  readonly progressSink?: AssistantProgressSink;
  readonly signal?: AbortSignal;
  readonly requestId?: string;
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
    options?: AssistantChatOptions,
  ): Promise<AssistantChatResponseData> {
    const startTime = Date.now();
    const telemetryCollector = new SimpleAiTelemetryCollector();
    const getNow = this.dependencies.now ?? (() => new Date().toISOString());
    const requestStartedAt = getNow();
    const requestId = options?.requestId ?? `req-${crypto.randomUUID()}`;
    const emitter = new ProgressEmitter(
      options?.progressSink ?? new NoopAssistantProgressSink(),
      requestId,
      getNow,
    );

    await emitter.emit({ stage: "RECEIVED" });

    const conversationId =
      request.conversationId ?? `conv-${crypto.randomUUID()}`;
    if (!request.conversationId) {
      await this.dependencies.store.createConversation(
        conversationId,
        requestStartedAt,
      );
    }
    const sanitizedMessage = redactAssistantMessage(request.message);

    await emitter.emit({ stage: "CONTEXT" });

    const priorTurns = await this.dependencies.store.recentTurns(
      conversationId,
      MAX_CONTEXT_TURNS,
    );
    const context = boundedContext(priorTurns);
    const turn = await this.dependencies.store.beginTurn({
      turnId: `turn-${crypto.randomUUID()}`,
      conversationId,
      userMessage: sanitizedMessage,
      createdAt: requestStartedAt,
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
      const turnStatus =
        input.status === "CLARIFICATION_REQUIRED"
          ? "CLARIFICATION_REQUIRED"
          : input.status === "DENIED"
            ? "DENIED"
            : input.status === "COMPLETED"
              ? "COMPLETED"
              : "FAILED";

      await this.dependencies.store.completeTurn({
        turnId: turn.turnId,
        kind: input.kind,
        status: turnStatus,
        assistantMessage: safeMessage,
        decisionSummary: input.decisionSummary,
        cueId: input.cueId,
        sessionId: input.sessionId,
        executionId: input.executionId,
        verificationId: input.verificationId,
        completedAt: getNow(),
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
      await emitter.emit({
        stage: "COMPLETED",
        provider: "autodo",
        model: "deterministic",
        fallback: false,
      });
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
      await emitter.emit({ stage: "SAFETY_CHECK" });
      await emitter.emit({
        stage: "DENIED",
        provider: "autodo",
        model: "deterministic",
        fallback: false,
      });
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
      await emitter.emit({ stage: "ROUTING" });
      await emitter.emit({
        stage: "MODEL_SELECTED",
        provider: activeProvider,
        model: activeModel,
        message: safeModelSelectedMessage(activeProvider, activeModel),
        fallback: false,
      });
      await emitter.emit({ stage: "GENERATING" });

      // 3. Ingress Intent Interpretation (with fallback)
      let intent: AssistantIntent;
      try {
        const primaryInterpreter = this.getInterpreter(
          routeDecision.selectedProvider,
        );
        intent = await primaryInterpreter.interpret(sanitizedMessage, context, {
          telemetryCollector,
          model: routeDecision.selectedModel,
          signal: options?.signal,
          onRetry: async (info) => {
            await emitter.emit({
              stage: "RETRYING",
              provider: info.provider as ModelProviderName,
              model: info.model,
              attempt: info.attempt,
              message: safeRetryMessage(info.errorCode),
            });
          },
        });
      } catch (interpreterError: unknown) {
        if (
          isCrossProviderFallbackEligible(interpreterError, options?.signal) &&
          routeDecision.fallbackChain.length > 0
        ) {
          const fallback = routeDecision.fallbackChain[0];
          fallbackUsed = true;
          activeProvider = fallback.provider;
          activeModel = fallback.model;
          await emitter.emit({ stage: "FALLBACK" });
          await emitter.emit({
            stage: "MODEL_SELECTED",
            provider: activeProvider,
            model: activeModel,
            message: safeModelSelectedMessage(activeProvider, activeModel),
            fallback: true,
          });
          await emitter.emit({ stage: "GENERATING" });
          const fallbackInterpreter = this.getInterpreter(fallback.provider);
          intent = await fallbackInterpreter.interpret(
            sanitizedMessage,
            context,
            {
              telemetryCollector,
              model: fallback.model,
              signal: options?.signal,
              onRetry: async (info) => {
                await emitter.emit({
                  stage: "RETRYING",
                  provider: info.provider as ModelProviderName,
                  model: info.model,
                  attempt: info.attempt,
                  message: safeRetryMessage(info.errorCode),
                });
              },
            },
          );
        } else {
          throw interpreterError;
        }
      }

      if (intent.kind === "DENIED") {
        await emitter.emit({ stage: "DENIED" });
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
        await emitter.emit({ stage: "CLARIFICATION_REQUIRED" });
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
        await emitter.emit({ stage: "COMPOSING" });
        let message: string;
        try {
          const primaryComposer = this.getComposer(activeProvider);
          message = await primaryComposer.composeDirect(
            sanitizedMessage,
            context,
            {
              telemetryCollector,
              model: activeModel,
              signal: options?.signal,
              onRetry: async (info) => {
                await emitter.emit({
                  stage: "RETRYING",
                  provider: info.provider as ModelProviderName,
                  model: info.model,
                  attempt: info.attempt,
                  message: safeRetryMessage(info.errorCode),
                });
              },
            },
          );
        } catch (composerError: unknown) {
          if (
            !fallbackUsed &&
            isCrossProviderFallbackEligible(composerError, options?.signal) &&
            routeDecision.fallbackChain.length > 0
          ) {
            const fallback = routeDecision.fallbackChain[0];
            fallbackUsed = true;
            activeProvider = fallback.provider;
            activeModel = fallback.model;
            await emitter.emit({ stage: "FALLBACK" });
            await emitter.emit({
              stage: "MODEL_SELECTED",
              provider: activeProvider,
              model: activeModel,
              message: safeModelSelectedMessage(activeProvider, activeModel),
              fallback: true,
            });
            await emitter.emit({ stage: "COMPOSING" });
            const fallbackComposer = this.getComposer(fallback.provider);
            message = await fallbackComposer.composeDirect(
              sanitizedMessage,
              context,
              {
                telemetryCollector,
                model: fallback.model,
                signal: options?.signal,
                onRetry: async (info) => {
                  await emitter.emit({
                    stage: "RETRYING",
                    provider: info.provider as ModelProviderName,
                    model: info.model,
                    attempt: info.attempt,
                    message: safeRetryMessage(info.errorCode),
                  });
                },
              },
            );
          } else {
            throw composerError;
          }
        }

        await emitter.emit({ stage: "COMPLETED" });
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
        getNow(),
        {
          signal: options?.signal,
          onStage: async (stage) => {
            if (stage === "TOOL_EXECUTION") {
              await emitter.emit({
                stage: "TOOL_EXECUTION",
                message: safeToolExecutionMessage(intent),
              });
            } else {
              await emitter.emit({ stage });
            }
          },
        },
      );
      completedTool = tool;
      const links = {
        cueId: tool.cueId,
        sessionId: tool.sessionId,
        executionId: tool.executionId,
        verificationId: tool.verificationId,
      };

      if (tool.status === "VERIFIED" && tool.verifiedFacts) {
        await emitter.emit({ stage: "COMPOSING" });
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
              signal: options?.signal,
              onRetry: async (info) => {
                await emitter.emit({
                  stage: "RETRYING",
                  provider: info.provider as ModelProviderName,
                  model: info.model,
                  attempt: info.attempt,
                  message: safeRetryMessage(info.errorCode),
                });
              },
            },
          });
        } catch (composerError: unknown) {
          if (
            !fallbackUsed &&
            isCrossProviderFallbackEligible(composerError, options?.signal) &&
            routeDecision.fallbackChain.length > 0
          ) {
            const fallback = routeDecision.fallbackChain[0];
            fallbackUsed = true;
            activeProvider = fallback.provider;
            activeModel = fallback.model;
            await emitter.emit({ stage: "FALLBACK" });
            await emitter.emit({
              stage: "MODEL_SELECTED",
              provider: activeProvider,
              model: activeModel,
              message: safeModelSelectedMessage(activeProvider, activeModel),
              fallback: true,
            });
            await emitter.emit({ stage: "COMPOSING" });
            const fallbackComposer = this.getComposer(fallback.provider);
            message = await fallbackComposer.composeVerified({
              message: sanitizedMessage,
              context,
              verifiedFacts: tool.verifiedFacts,
              options: {
                telemetryCollector,
                model: fallback.model,
                signal: options?.signal,
                onRetry: async (info) => {
                  await emitter.emit({
                    stage: "RETRYING",
                    provider: info.provider as ModelProviderName,
                    model: info.model,
                    attempt: info.attempt,
                    message: safeRetryMessage(info.errorCode),
                  });
                },
              },
            });
          } else {
            throw composerError;
          }
        }

        await emitter.emit({ stage: "COMPLETED" });
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
        await emitter.emit({ stage: "DENIED" });
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

      if (tool.status === "RECONCILIATION_REQUIRED") {
        await emitter.emit({ stage: "RECONCILIATION_REQUIRED" });
      } else {
        await emitter.emit({ stage: "FAILED" });
      }

      return finish({
        ...links,
        kind: "TOOL_REQUIRED",
        status:
          tool.status === "RECONCILIATION_REQUIRED"
            ? "FAILED"
            : tool.status === "FAILED"
              ? "UNVERIFIED"
              : "FAILED",
        message:
          tool.status === "RECONCILIATION_REQUIRED"
            ? "The operation requires reconciliation before AutoDo can continue safely."
            : "I couldn’t verify that result yet.",
        verification,
        decisionSummary: [
          `The tool cycle concluded with status ${tool.status}.`,
          tool.reason ?? "Tool execution failed.",
        ],
      });
    } catch (error: unknown) {
      const isAborted =
        options?.signal?.aborted ||
        (error instanceof Error && error.name === "AbortError");

      if (isAborted) {
        try {
          await this.dependencies.store.completeTurn({
            turnId: turn.turnId,
            kind: completedTool ? "TOOL_REQUIRED" : "DIRECT_ANSWER",
            status: "FAILED",
            assistantMessage: "Request canceled by caller.",
            decisionSummary: externalActionAttempted
              ? [
                  "The request was canceled by the caller.",
                  "Durable external action state was preserved.",
                ]
              : [
                  "The request was canceled by the caller.",
                  "No external action was performed.",
                ],
            cueId: completedTool?.cueId ?? null,
            sessionId: completedTool?.sessionId ?? null,
            executionId: completedTool?.executionId ?? null,
            verificationId: completedTool?.verificationId ?? null,
            completedAt: getNow(),
          });
        } catch {
          // Ignore if turn was already completed
        }

        throw error instanceof Error && error.name === "AbortError"
          ? error
          : new DOMException("The operation was aborted.", "AbortError");
      }
      await emitter.emit({ stage: "FAILED" });
      const failure = safeProviderFailure(error);
      const decisionSummary = externalActionAttempted
        ? [
            failure.summary,
            "No unverified provider result was presented as fact.",
          ]
        : [failure.summary, "No external action was performed."];

      return finish({
        kind: "DIRECT_ANSWER",
        status: "FAILED",
        providerStatus: failure.providerStatus,
        message: "I couldn’t complete that request safely.",
        verification: completedTool ? "UNKNOWN" : "UNKNOWN",
        sessionId: completedTool?.sessionId ?? null,
        executionId: completedTool?.executionId ?? null,
        decisionSummary,
      });
    }
  }
}
