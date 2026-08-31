import type {
  StructuredAiProvider,
  StructuredAiRequest,
  StructuredAiResponse,
} from "../ai-provider-contract";
import { AiProviderError } from "../ai-errors";

export interface FakeAiProviderOptions<T = unknown> {
  readonly fixedValue?: T;
  readonly errorToThrow?: Error;
  readonly latencyMs?: number;
  readonly recordRequests?: boolean;
}

export class FakeStructuredAiProvider implements StructuredAiProvider {
  readonly providerName = "fake-gemini";
  readonly defaultModel = "gemini-3.7-flash";
  readonly recordedRequests: StructuredAiRequest<unknown>[] = [];

  constructor(private readonly options: FakeAiProviderOptions = {}) {}

  async generateStructured<T>(
    request: StructuredAiRequest<T>,
  ): Promise<StructuredAiResponse<T>> {
    if (this.options.recordRequests !== false) {
      this.recordedRequests.push(request as StructuredAiRequest<unknown>);
    }

    if (this.options.errorToThrow) {
      throw this.options.errorToThrow;
    }

    if (this.options.fixedValue !== undefined) {
      const parsed = request.schema.safeParse(this.options.fixedValue);
      if (!parsed.success) {
        throw AiProviderError.invalidStructuredOutput(
          this.providerName,
          `Fake value failed schema: ${JSON.stringify(parsed.error.issues)}`,
        );
      }
      return {
        provider: this.providerName,
        model: request.model ?? this.defaultModel,
        value: parsed.data,
        latencyMs: this.options.latencyMs ?? 10,
        finishedAt: new Date().toISOString(),
        usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
      };
    }

    throw AiProviderError.invalidStructuredOutput(
      this.providerName,
      "No fake value or generator configured.",
    );
  }
}
