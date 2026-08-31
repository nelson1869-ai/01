import {
  apiError,
  apiSuccess,
  handleRouteError,
} from "../../../../features/cognitive/api/api-response";
import { GeminiStructuredAiProvider } from "../../../../features/cognitive/ai/gemini-provider";
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

import { ReliableStructuredAiProvider } from "../../../../features/cognitive/ai/reliable-provider";

function createDefaultService(): AssistantChatService {
  const { db } = getDatabaseContext();
  const rawAi = new GeminiStructuredAiProvider({
    defaultModel: "gemini-3.7-flash",
    defaultTimeoutMs: 30_000,
  });
  const ai = new ReliableStructuredAiProvider(rawAi);
  return new AssistantChatService({
    store: new DatabaseAssistantConversationStore(db),
    interpreter: new GeminiAssistantIntentInterpreter(ai),
    composer: new GeminiAssistantResponseComposer(ai),
    toolRunner: new DatabaseAssistantToolRunner(db),
  });
}

export async function POST(request: Request) {
  return createAssistantChatPostHandler(createDefaultService())(request);
}
