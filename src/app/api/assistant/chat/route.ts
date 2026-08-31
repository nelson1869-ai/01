import {
  apiError,
  apiSuccess,
  handleRouteError,
} from "../../../../features/cognitive/api/api-response";
import { GeminiStructuredAiProvider } from "../../../../features/cognitive/ai/gemini-provider";
import { OllamaStructuredAiProvider } from "../../../../features/cognitive/ai/ollama-provider";
import { ReliableStructuredAiProvider } from "../../../../features/cognitive/ai/reliable-provider";
import {
  GeminiAssistantIntentInterpreter,
  GeminiAssistantResponseComposer,
} from "../../../../features/cognitive/api/assistant-ai";
import { assistantChatRequestSchema } from "../../../../features/cognitive/api/assistant-chat-contracts";
import {
  AssistantChatService,
  DatabaseAssistantConversationStore,
} from "../../../../features/cognitive/api/assistant-chat-service";
import { DatabaseAssistantToolRunner } from "../../../../features/cognitive/api/assistant-tool-runtime";
import { getDatabaseContext } from "../../../../features/cognitive/persistence/postgres/database";

export function createAssistantChatPostHandler(
  service: Pick<AssistantChatService, "chat">,
) {
  return async function POST(request: Request) {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return apiError("INVALID_JSON", "Request body must be valid JSON.", 400);
    }
    try {
      const body = assistantChatRequestSchema.parse(rawBody);
      return apiSuccess(await service.chat(body));
    } catch (error) {
      return handleRouteError(error);
    }
  };
}

export function createDefaultAssistantChatService(): AssistantChatService {
  const { db } = getDatabaseContext();
  const rawGemini = new GeminiStructuredAiProvider({
    defaultModel: "gemini-3.5-flash-lite",
    defaultTimeoutMs: 30_000,
  });
  const gemini = new ReliableStructuredAiProvider(rawGemini);

  const rawOllama = new OllamaStructuredAiProvider({
    defaultModel: "qwen3.5:9b",
    defaultTimeoutMs: 60_000,
  });
  const ollama = new ReliableStructuredAiProvider(rawOllama);

  return new AssistantChatService({
    store: new DatabaseAssistantConversationStore(db),
    toolRunner: new DatabaseAssistantToolRunner(db),
    providers: {
      gemini,
      ollama,
    },
    interpreter: new GeminiAssistantIntentInterpreter(ollama),
    composer: new GeminiAssistantResponseComposer(ollama),
    fallbackInterpreter: new GeminiAssistantIntentInterpreter(gemini),
    fallbackComposer: new GeminiAssistantResponseComposer(gemini),
  });
}

export async function POST(request: Request) {
  return createAssistantChatPostHandler(createDefaultAssistantChatService())(
    request,
  );
}
