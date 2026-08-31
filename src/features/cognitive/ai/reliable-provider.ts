import type {
  StructuredAiProvider,
  StructuredAiRequest,
  StructuredAiResponse,
} from "./ai-provider-contract";
import { AiProviderError, type AiErrorCode } from "./ai-errors";

export const RETRYABLE_AI_ERROR_CODES: ReadonlySet<AiErrorCode> = new Set([
  "TIMEOUT",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
]);

export const DEFAULT_BACKOFF_DELAYS_MS: Readonly<
  Record<"TIMEOUT" | "RATE_LIMITED" | "PROVIDER_UNAVAILABLE", number>
> = {
  TIMEOUT: 500,
  PROVIDER_UNAVAILABLE: 750,
  RATE_LIMITED: 1000,
};

export interface AiAttemptTelemetry {
  readonly stage: string;
  readonly provider: string;
  readonly model: string;
  readonly attempt: number;
  readonly durationMs: number;
  readonly outcome: "SUCCESS" | AiErrorCode | "UNKNOWN_ERROR";
  readonly backoffMs?: number;
}

export interface AiStageTelemetry {
  readonly stage: string;
  readonly provider: string;
  readonly model: string;
  readonly attemptCount: number;
  readonly retried: boolean;
  readonly durationMs: number;
  readonly finalStatus: "READY" | AiErrorCode;
}

export interface AiTelemetryCollector {
  record(stageTelemetry: AiStageTelemetry): void;
  getStages(): readonly AiStageTelemetry[];
}

export class SimpleAiTelemetryCollector implements AiTelemetryCollector {
  private readonly stages: AiStageTelemetry[] = [];

  record(stageTelemetry: AiStageTelemetry): void {
    this.stages.push(stageTelemetry);
  }

  getStages(): readonly AiStageTelemetry[] {
    return [...this.stages];
  }
}

export interface ReliableProviderOptions {
  readonly maxRetries?: number; // default: 1 (max 2 attempts)
  readonly backoffDelaysMs?: Partial<
    Record<"TIMEOUT" | "RATE_LIMITED" | "PROVIDER_UNAVAILABLE", number>
  >;
  readonly sleepFn?: (ms: number) => Promise<void>;
  readonly telemetryCollector?: AiTelemetryCollector;
}

export function normalizeAiStage(taskName: string): string {
  switch (taskName) {
    case "assistant-intent":
      return "assistant.intent";
    case "assistant-direct-response":
      return "assistant.compose.direct";
    case "assistant-verified-response":
      return "assistant.compose.verified";
    case "candidate-generation":
      return "candidate.generate";
    default:
      return taskName;
  }
}

export class ReliableStructuredAiProvider implements StructuredAiProvider {
  readonly providerName: string;
  readonly defaultModel: string;

  private readonly maxRetries: number;
  private readonly backoffDelaysMs: Record<
    "TIMEOUT" | "RATE_LIMITED" | "PROVIDER_UNAVAILABLE",
    number
  >;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly defaultCollector?: AiTelemetryCollector;

  constructor(
    private readonly delegate: StructuredAiProvider,
    options: ReliableProviderOptions = {},
  ) {
    this.providerName = delegate.providerName;
    this.defaultModel = delegate.defaultModel;
    this.maxRetries = options.maxRetries ?? 1;
    this.backoffDelaysMs = {
      ...DEFAULT_BACKOFF_DELAYS_MS,
      ...(options.backoffDelaysMs ?? {}),
    };
    this.sleepFn =
      options.sleepFn ?? ((ms: number) => new Promise((res) => setTimeout(res, ms)));
    this.defaultCollector = options.telemetryCollector;
  }

  async generateStructured<T>(
    request: StructuredAiRequest<T>,
  ): Promise<StructuredAiResponse<T>> {
    const stage = normalizeAiStage(request.taskName);
    const collector = request.telemetryCollector ?? this.defaultCollector;
    const model = request.model ?? this.defaultModel;
    const stageStart = Date.now();

    let attempt = 1;
    const maxAttempts = 1 + this.maxRetries;

    while (attempt <= maxAttempts) {
      try {
        const response = await this.delegate.generateStructured(request);
        const durationMs = Date.now() - stageStart;

        collector?.record({
          stage,
          provider: response.provider,
          model: response.model,
          attemptCount: attempt,
          retried: attempt > 1,
          durationMs,
          finalStatus: "READY",
        });

        return response;
      } catch (err: unknown) {
        const isAiError = err instanceof AiProviderError;
        const errorCode: AiErrorCode = isAiError
          ? err.code
          : "UNKNOWN_PROVIDER_FAILURE";

        const isRetryable =
          isAiError &&
          RETRYABLE_AI_ERROR_CODES.has(err.code) &&
          attempt < maxAttempts;

        if (isRetryable) {
          const backoffKey = err.code as keyof typeof DEFAULT_BACKOFF_DELAYS_MS;
          const backoffMs = this.backoffDelaysMs[backoffKey] ?? 500;
          await this.sleepFn(backoffMs);
          attempt++;
          continue;
        }

        const durationMs = Date.now() - stageStart;
        collector?.record({
          stage,
          provider: this.providerName,
          model,
          attemptCount: attempt,
          retried: attempt > 1,
          durationMs,
          finalStatus: errorCode,
        });

        throw err;
      }
    }

    throw AiProviderError.unknown(this.providerName, "Retry loop terminated unexpectedly.");
  }
}
