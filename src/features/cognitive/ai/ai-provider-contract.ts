import type { z } from "zod";

export interface StructuredAiRequest<T> {
  readonly taskName: string;
  readonly systemInstruction: string;
  readonly prompt: string;
  readonly schema: z.ZodType<T>;
  readonly jsonSchema?: Record<string, unknown>;
  readonly timeoutMs?: number;
  readonly model?: string;
  readonly signal?: AbortSignal;
  readonly onRetry?: (info: {
    stage: string;
    provider: string;
    model: string;
    attempt: number;
    errorCode: string;
  }) => void | Promise<void>;
  readonly telemetryCollector?: {
    record(stageTelemetry: {
      stage: string;
      provider: string;
      model: string;
      attemptCount: number;
      retried: boolean;
      durationMs: number;
      finalStatus: string;
    }): void;
  };
}

export interface StructuredAiUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

export interface StructuredAiResponse<T> {
  readonly provider: string;
  readonly model: string;
  readonly value: T;
  readonly latencyMs: number;
  readonly finishedAt: string;
  readonly usage?: StructuredAiUsage;
}

export interface StructuredAiProvider {
  readonly providerName: string;
  readonly defaultModel: string;

  generateStructured<T>(
    request: StructuredAiRequest<T>,
  ): Promise<StructuredAiResponse<T>>;
}
