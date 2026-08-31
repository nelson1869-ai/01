import type {
  AssistantTurnKind,
  AssistantTurnStatus,
  PersistedAssistantConversation,
  PersistedAssistantTurn,
} from "../persistence/contracts/assistant-conversation";
import { AiProviderError, type AiErrorCode } from "../ai/ai-errors";
import { assistantConversationRepository } from "../persistence/postgres/repositories/assistant-conversation-repository";
import type { DatabaseClient } from "../persistence/postgres/transactions/transaction-executor";
import type {
  AssistantIntentInterpreterPort,
  AssistantResponseComposerPort,
  SafeConversationTurn,
} from "./assistant-ai";
import type {
  AssistantChatRequest,
  AssistantChatResponseData,
  AssistantProviderStatus,
} from "./assistant-chat-contracts";
import {
  MAX_CONTEXT_CHARACTERS,
  MAX_CONTEXT_TURNS,
} from "./assistant-chat-contracts";
import {
  deterministicDenialReason,
  redactAssistantMessage,
} from "./assistant-security";
import type { AssistantToolRunnerPort } from "./assistant-tool-runtime";

export interface AssistantConversationStorePort {
  createConversation(
    conversationId: string,
    now: string,
  ): Promise<PersistedAssistantConversation>;
  findConversation(
    conversationId: string,
  ): Promise<PersistedAssistantConversation | null>;
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
  }): Promise<PersistedAssistantTurn>;
  recentTurns(
    conversationId: string,
    limit: number,
  ): Promise<PersistedAssistantTurn[]>;
}

export class DatabaseAssistantConversationStore implements AssistantConversationStorePort {
  constructor(private readonly db: DatabaseClient) {}
  async createConversation(conversationId: string, now: string) {
    await assistantConversationRepository.pruneExpiredConversations(
      this.db,
      now,
    );
    return assistantConversationRepository.createConversation(
      this.db,
      conversationId,
      now,
    );
  }
  findConversation(conversationId: string) {
    return assistantConversationRepository.findConversationById(
      this.db,
      conversationId,
    );
  }
  beginTurn(input: {
    turnId: string;
    conversationId: string;
    userMessage: string;
    createdAt: string;
  }) {
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

const PROVIDER_FAILURE_SUMMARIES: Readonly<Record<AiErrorCode, string>> = {
  MISSING_CREDENTIAL:
    "The Gemini provider is not configured with a credential.",
  AUTHENTICATION_FAILED: "The Gemini provider could not authenticate.",
  RATE_LIMITED: "The Gemini provider is currently rate limited.",
  TIMEOUT: "The Gemini provider timed out.",
  PROVIDER_UNAVAILABLE: "The Gemini provider is currently unavailable.",
  SAFETY_BLOCKED:
    "The Gemini provider blocked the request through its safety controls.",
  INVALID_STRUCTURED_OUTPUT:
    "The Gemini provider returned an invalid structured response.",
  RESPONSE_TOO_LARGE:
    "The Gemini provider response exceeded the safe size limit.",
  UNKNOWN_PROVIDER_FAILURE:
    "The assistant encountered an unknown provider failure.",
};

function safeProviderFailure(error: unknown): {
  readonly providerStatus: AssistantProviderStatus;
  readonly summary: string;
} {
  const code =
    error instanceof AiProviderError ? error.code : "UNKNOWN_PROVIDER_FAILURE";
  return {
    providerStatus: code,
    summary: PROVIDER_FAILURE_SUMMARIES[code],
  };
}

import { SimpleAiTelemetryCollector } from "../ai/reliable-provider";

export class AssistantChatService {
  constructor(
    private readonly dependencies: {
      readonly store: AssistantConversationStorePort;
      readonly interpreter: AssistantIntentInterpreterPort;
      readonly composer: AssistantResponseComposerPort;
      readonly toolRunner: AssistantToolRunnerPort;
      readonly now?: () => string;
    },
  ) {}

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
      return {
        conversationId,
        message: safeMessage,
        status:
          input.status === "CLARIFICATION_REQUIRED"
            ? "CLARIFICATION_REQUIRED"
            : input.status,
        providerStatus: input.providerStatus ?? null,
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
      });
    }

    try {
      const intent = await this.dependencies.interpreter.interpret(
        sanitizedMessage,
        context,
        {
          telemetryCollector,
        },
      );
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
        const message = await this.dependencies.composer.composeDirect(
          sanitizedMessage,
          context,
          {
            telemetryCollector,
          },
        );
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
        const message = await this.dependencies.composer.composeVerified({
          message: sanitizedMessage,
          context,
          verifiedFacts: tool.verifiedFacts,
          options: { telemetryCollector },
        });
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
