import { GoogleGenAI } from "@google/genai";
import { AiProviderError } from "./ai-errors";
import type {
  StructuredAiProvider,
  StructuredAiRequest,
  StructuredAiResponse,
} from "./ai-provider-contract";

export interface GeminiProviderOptions {
  readonly apiKey?: string;
  readonly defaultModel?: string;
  readonly defaultTimeoutMs?: number;
}

export class GeminiStructuredAiProvider implements StructuredAiProvider {
  readonly providerName = "gemini";
  readonly defaultModel: string;
  private readonly defaultTimeoutMs: number;
  private readonly client: GoogleGenAI | null;

  constructor(options?: GeminiProviderOptions) {
    this.defaultModel = options?.defaultModel ?? "gemini-3.7-flash";
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 30_000;

    const apiKey = options?.apiKey ?? process.env.GEMINI_API_KEY;
    if (apiKey) {
      this.client = new GoogleGenAI({ apiKey });
    } else {
      this.client = null;
    }
  }

  async generateStructured<T>(
    request: StructuredAiRequest<T>,
  ): Promise<StructuredAiResponse<T>> {
    if (!this.client) {
      throw AiProviderError.missingCredential(this.providerName);
    }

    const modelName = request.model ?? this.defaultModel;
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const startTime = Date.now();

    const generatePromise = (async () => {
      try {
        const config: Record<string, unknown> = {
          systemInstruction: request.systemInstruction,
          responseMimeType: "application/json",
        };

        if (request.jsonSchema) {
          config.responseSchema = request.jsonSchema;
        }

        const response = await this.client!.models.generateContent({
          model: modelName,
          contents: request.prompt,
          config,
        });

        return response;
      } catch (err: unknown) {
        throw this.mapGeminiError(err);
      }
    })();

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(AiProviderError.timeout(this.providerName, timeoutMs));
      }, timeoutMs);
    });

    try {
      const response = await Promise.race([generatePromise, timeoutPromise]);
      const latencyMs = Date.now() - startTime;
      const finishedAt = new Date().toISOString();

      const rawText = response.text;
      if (!rawText) {
        throw AiProviderError.invalidStructuredOutput(
          this.providerName,
          "Gemini returned an empty response text.",
        );
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawText);
      } catch (parseError: unknown) {
        const msg = parseError instanceof Error ? parseError.message : String(parseError);
        throw AiProviderError.invalidStructuredOutput(
          this.providerName,
          `Failed to parse response JSON: ${msg}`,
        );
      }

      // Re-validate untrusted model output strictly with Zod schema
      const validation = request.schema.safeParse(parsedJson);
      if (!validation.success) {
        throw AiProviderError.invalidStructuredOutput(
          this.providerName,
          `Schema validation failed: ${JSON.stringify(validation.error.issues)}`,
        );
      }

      const usageMetadata = response.usageMetadata;
      const usage = usageMetadata
        ? {
            promptTokens: usageMetadata.promptTokenCount,
            completionTokens: usageMetadata.candidatesTokenCount,
            totalTokens: usageMetadata.totalTokenCount,
          }
        : undefined;

      return {
        provider: this.providerName,
        model: modelName,
        value: validation.data,
        latencyMs,
        finishedAt,
        usage,
      };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private mapGeminiError(err: unknown): AiProviderError {
    if (err instanceof AiProviderError) {
      return err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();

    if (
      lower.includes("api_key") ||
      lower.includes("apikey") ||
      lower.includes("unauthorized") ||
      lower.includes("invalid authentication") ||
      lower.includes("permission_denied") ||
      lower.includes("401")
    ) {
      return AiProviderError.authenticationFailed(this.providerName);
    }

    if (
      lower.includes("quota") ||
      lower.includes("rate limit") ||
      lower.includes("resource_exhausted") ||
      lower.includes("429")
    ) {
      return AiProviderError.rateLimited(this.providerName);
    }

    if (lower.includes("safety") || lower.includes("blocked") || lower.includes("harm")) {
      return AiProviderError.safetyBlocked(this.providerName, message);
    }

    if (
      lower.includes("unavailable") ||
      lower.includes("service error") ||
      lower.includes("503") ||
      lower.includes("500") ||
      lower.includes("econnrefused")
    ) {
      return AiProviderError.providerUnavailable(this.providerName, message);
    }

    return AiProviderError.unknown(this.providerName, err);
  }
}
