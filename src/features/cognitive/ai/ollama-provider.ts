import { AiProviderError } from "./ai-errors";
import type {
  StructuredAiProvider,
  StructuredAiRequest,
  StructuredAiResponse,
} from "./ai-provider-contract";

export interface OllamaProviderConfig {
  readonly baseUrl?: string;
  readonly defaultModel?: string;
  readonly defaultTimeoutMs?: number;
  readonly fetchFn?: typeof fetch;
}

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL = "qwen3.5:9b";
const DEFAULT_OLLAMA_TIMEOUT_MS = 60_000;
const MAX_LOCAL_OUTPUT_CHARS = 100_000;

function validateLoopbackUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid Ollama base URL: ${rawUrl}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  const isLoopback =
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]";

  if (!isLoopback) {
    throw new Error(
      `Ollama base URL must be a local loopback address (127.0.0.1, localhost, ::1). Refusing connection to: ${rawUrl}`,
    );
  }
  return parsed;
}

export function stripThinking(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export class OllamaStructuredAiProvider implements StructuredAiProvider {
  readonly providerName = "ollama";
  readonly defaultModel: string;
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: OllamaProviderConfig = {}) {
    const rawUrl =
      config.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
    const validated = validateLoopbackUrl(rawUrl);
    this.baseUrl = validated.toString().replace(/\/$/, "");
    this.defaultModel =
      config.defaultModel ?? process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL;
    this.defaultTimeoutMs =
      config.defaultTimeoutMs ??
      (process.env.OLLAMA_TIMEOUT_MS
        ? Number(process.env.OLLAMA_TIMEOUT_MS)
        : DEFAULT_OLLAMA_TIMEOUT_MS);
    this.fetchFn = config.fetchFn ?? fetch;
  }

  async generateStructured<T>(
    request: StructuredAiRequest<T>,
  ): Promise<StructuredAiResponse<T>> {
    const model = request.model ?? this.defaultModel;
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(AiProviderError.timeout(this.providerName, timeoutMs));
      }, timeoutMs);
    });

    const startTime = Date.now();

    try {
      const executeCall = async (): Promise<StructuredAiResponse<T>> => {
        const payload: Record<string, unknown> = {
          model,
          messages: [
            { role: "system", content: request.systemInstruction },
            { role: "user", content: request.prompt },
          ],
          stream: false,
          options: {
            temperature: 0,
            num_ctx: 4096,
          },
        };

        if (request.jsonSchema) {
          payload.format = request.jsonSchema;
        } else {
          payload.format = "json";
        }

        let response: Response;
        try {
          response = await this.fetchFn(`${this.baseUrl}/api/chat`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
        } catch (fetchError: unknown) {
          if (controller.signal.aborted) {
            throw AiProviderError.timeout(this.providerName, timeoutMs);
          }
          const message =
            fetchError instanceof Error
              ? fetchError.message
              : String(fetchError);
          throw AiProviderError.providerUnavailable(
            this.providerName,
            `Cannot connect to local Ollama runtime at ${this.baseUrl}: ${message}`,
          );
        }

        if (!response.ok) {
          const status = response.status;
          let bodyText = "";
          try {
            bodyText = await response.text();
          } catch {
            // ignore
          }

          if (status === 404) {
            throw AiProviderError.providerUnavailable(
              this.providerName,
              `Ollama model '${model}' not found or endpoint missing. Please ensure 'ollama pull ${model}' was run. ${bodyText}`,
            );
          }
          if (status === 429) {
            throw AiProviderError.rateLimited(this.providerName);
          }
          throw AiProviderError.providerUnavailable(
            this.providerName,
            `Ollama returned HTTP ${status}: ${bodyText}`,
          );
        }

        const rawText = await response.text();
        if (rawText.length > MAX_LOCAL_OUTPUT_CHARS) {
          throw new AiProviderError(
            `Ollama response length ${rawText.length} exceeded maximum allowed of ${MAX_LOCAL_OUTPUT_CHARS}`,
            {
              code: "RESPONSE_TOO_LARGE",
              provider: this.providerName,
            },
          );
        }

        let parsedJson: {
          message?: { content?: string; thinking?: unknown };
          response?: string;
          prompt_eval_count?: number;
          eval_count?: number;
        };

        try {
          parsedJson = JSON.parse(rawText);
        } catch {
          throw AiProviderError.invalidStructuredOutput(
            this.providerName,
            "Failed to parse Ollama response as JSON envelope",
          );
        }

        // Strictly extract message content or response, completely discarding thinking
        const rawContent =
          parsedJson.message?.content ?? parsedJson.response ?? "";
        const cleanContent = stripThinking(rawContent);

        if (!cleanContent) {
          throw AiProviderError.invalidStructuredOutput(
            this.providerName,
            "Ollama returned empty message content",
          );
        }

        let structuredData: unknown;
        try {
          structuredData = JSON.parse(cleanContent);
        } catch {
          throw AiProviderError.invalidStructuredOutput(
            this.providerName,
            `Model output was not valid JSON: ${cleanContent.slice(0, 200)}`,
          );
        }

        const validation = request.schema.safeParse(structuredData);
        if (!validation.success) {
          throw AiProviderError.invalidStructuredOutput(
            this.providerName,
            `Ollama output failed schema validation: ${validation.error.message}`,
          );
        }

        const latencyMs = Date.now() - startTime;
        return {
          provider: this.providerName,
          model,
          value: validation.data,
          latencyMs,
          finishedAt: new Date().toISOString(),
          usage: {
            promptTokens: parsedJson.prompt_eval_count,
            completionTokens: parsedJson.eval_count,
            totalTokens:
              (parsedJson.prompt_eval_count ?? 0) +
              (parsedJson.eval_count ?? 0),
          },
        };
      };

      return await Promise.race([executeCall(), timeoutPromise]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  async checkHealth(): Promise<{
    available: boolean;
    models: readonly string[];
    error?: string;
  }> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/api/tags`, {
        method: "GET",
      });
      if (!response.ok) {
        return {
          available: false,
          models: [],
          error: `HTTP ${response.status}`,
        };
      }
      const data = (await response.json()) as {
        models?: Array<{ name: string }>;
      };
      const modelNames = (data.models ?? []).map((m) => m.name);
      return { available: true, models: modelNames };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { available: false, models: [], error: msg };
    }
  }
}
