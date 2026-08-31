import { z } from "zod";
import type { ModelProviderName } from "../ai/model-router";

export const assistantProgressStageSchema = z.enum([
  "RECEIVED",
  "CONTEXT",
  "ROUTING",
  "MODEL_SELECTED",
  "GENERATING",
  "RETRYING",
  "FALLBACK",
  "SAFETY_CHECK",
  "PLANNING",
  "TOOL_EXECUTION",
  "OBSERVING",
  "VERIFYING",
  "COMPOSING",
  "CLARIFICATION_REQUIRED",
  "DENIED",
  "RECONCILIATION_REQUIRED",
  "FAILED",
  "COMPLETED",
]);

export type AssistantProgressStage = z.infer<typeof assistantProgressStageSchema>;

export const safeAssistantProgressEventSchema = z.object({
  requestId: z.string().min(1).max(128),
  sequence: z.number().int().positive(),
  stage: assistantProgressStageSchema,
  message: z.string().min(1).max(512),
  occurredAt: z.string().datetime({ offset: true }),
  provider: z.enum(["autodo", "ollama", "gemini"]).optional(),
  model: z.string().min(1).max(128).optional(),
  attempt: z.number().int().positive().optional(),
  fallback: z.boolean().optional(),
});

export type SafeAssistantProgressEvent = z.infer<typeof safeAssistantProgressEventSchema>;

export interface AssistantProgressSink {
  emit(event: SafeAssistantProgressEvent): void | Promise<void>;
}

export class NoopAssistantProgressSink implements AssistantProgressSink {
  emit(): void {
    // Non-streaming operations intentionally ignore progress events
  }
}

export function safeModelSelectedMessage(
  provider: ModelProviderName,
  model?: string,
): string {
  if (provider === "autodo" || model === "deterministic") {
    return "Using AutoDo fast path.";
  }
  if (provider === "ollama" || model === "qwen3.5:9b") {
    return "Using local Qwen.";
  }
  if (model === "gemini-3.5-flash-lite") {
    return "Using Gemini Flash-Lite.";
  }
  if (model === "gemini-3.7-flash") {
    return "Using Gemini Flash.";
  }
  if (provider === "gemini") {
    return "Using Gemini.";
  }
  return `Using ${provider}.`;
}

export function safeToolExecutionMessage(input: {
  action?: string | null;
  path?: string | null;
  issueNumber?: number | null;
  pullNumber?: number | null;
}): string {
  if (input.path) {
    // Sanitize path for display - allow only safe alphanumeric path chars
    const sanitizedPath = input.path.replace(/[^a-zA-Z0-9_./-]/g, "").slice(0, 64);
    if (sanitizedPath.toLowerCase() === "readme.md") {
      return "Reading README.md.";
    }
    return `Reading ${sanitizedPath}.`;
  }
  if (input.issueNumber) {
    const num = Math.floor(Math.abs(input.issueNumber));
    return `Reading issue #${num}.`;
  }
  if (input.pullNumber) {
    const num = Math.floor(Math.abs(input.pullNumber));
    return `Reading pull request #${num}.`;
  }
  if (input.action === "github.issues.list") {
    return "Listing open issues.";
  }
  if (input.action === "github.pulls.list") {
    return "Listing open pull requests.";
  }
  return "Reading the repository.";
}

export function safeRetryMessage(reason?: string): string {
  if (reason === "RATE_LIMITED") {
    return "The AI provider is temporarily busy. Retrying safely.";
  }
  if (reason === "PROVIDER_UNAVAILABLE") {
    return "The AI provider is temporarily unavailable. Retrying safely.";
  }
  return "The AI provider is taking longer than expected. Retrying safely.";
}

export function safeStageMessage(stage: AssistantProgressStage): string {
  switch (stage) {
    case "RECEIVED":
      return "Request received.";
    case "CONTEXT":
      return "Loading conversation context.";
    case "ROUTING":
      return "Choosing the best model for this task.";
    case "MODEL_SELECTED":
      return "Model selected.";
    case "GENERATING":
      return "Processing your request.";
    case "RETRYING":
      return "The AI provider is taking longer than expected. Retrying safely.";
    case "FALLBACK":
      return "Switching to an approved fallback model.";
    case "SAFETY_CHECK":
      return "Checking safety and permissions.";
    case "PLANNING":
      return "Preparing the requested operation.";
    case "TOOL_EXECUTION":
      return "Reading the repository.";
    case "OBSERVING":
      return "Processing the tool result.";
    case "VERIFYING":
      return "Verifying the result.";
    case "COMPOSING":
      return "Preparing the final answer.";
    case "CLARIFICATION_REQUIRED":
      return "Clarification is required before proceeding.";
    case "DENIED":
      return "The request was denied by the current safety policy.";
    case "RECONCILIATION_REQUIRED":
      return "The operation requires reconciliation before AutoDo can continue safely.";
    case "FAILED":
      return "The request could not be completed safely.";
    case "COMPLETED":
      return "Done.";
    default:
      return "Processing request.";
  }
}

export interface EmitProgressOptions {
  stage: AssistantProgressStage;
  message?: string;
  provider?: ModelProviderName;
  model?: string;
  attempt?: number;
  fallback?: boolean;
}

export class ProgressEmitter {
  private sequence = 0;

  constructor(
    private readonly sink: AssistantProgressSink,
    readonly requestId: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async emit(options: EmitProgressOptions): Promise<SafeAssistantProgressEvent> {
    this.sequence += 1;
    const message = options.message ?? safeStageMessage(options.stage);
    const event: SafeAssistantProgressEvent = {
      requestId: this.requestId,
      sequence: this.sequence,
      stage: options.stage,
      message,
      occurredAt: this.now(),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
      ...(options.fallback !== undefined ? { fallback: options.fallback } : {}),
    };

    const parsed = safeAssistantProgressEventSchema.parse(event);
    await this.sink.emit(parsed);
    return parsed;
  }
}

export function formatSseEvent(eventName: string, data: unknown): string {
  const serialized = typeof data === "string" ? data : JSON.stringify(data);
  return `event: ${eventName}\ndata: ${serialized}\n\n`;
}
