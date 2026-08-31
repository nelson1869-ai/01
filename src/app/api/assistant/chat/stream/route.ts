import {
  apiError,
  handleRouteError,
} from "../../../../../features/cognitive/api/api-response";
import { assistantChatRequestSchema } from "../../../../../features/cognitive/api/assistant-chat-contracts";
import type { AssistantChatService } from "../../../../../features/cognitive/api/assistant-chat-service";
import {
  type AssistantProgressSink,
  type SafeAssistantProgressEvent,
  formatSseEvent,
} from "../../../../../features/cognitive/api/assistant-progress";
import { createDefaultAssistantChatService } from "../route";

const HEARTBEAT_INTERVAL_MS = 10_000;

export function createAssistantChatStreamPostHandler(
  service: Pick<AssistantChatService, "chat">,
) {
  return async function POST(request: Request): Promise<Response> {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return apiError("INVALID_JSON", "Request body must be valid JSON.", 400);
    }

    const parseResult = assistantChatRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return handleRouteError(parseResult.error);
    }
    const body = parseResult.data;

    const encoder = new TextEncoder();
    const requestId = `req-${crypto.randomUUID()}`;

    const stream = new ReadableStream({
      async start(controller) {
        let isClosed = false;
        let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

        const safeEnqueue = (text: string) => {
          if (!isClosed && !request.signal?.aborted) {
            try {
              controller.enqueue(encoder.encode(text));
            } catch {
              isClosed = true;
            }
          }
        };

        const safeClose = () => {
          if (!isClosed) {
            isClosed = true;
            if (heartbeatTimer) {
              clearInterval(heartbeatTimer);
              heartbeatTimer = null;
            }
            try {
              controller.close();
            } catch {
              // Ignore if already closed
            }
          }
        };

        // Start 10-second heartbeat
        heartbeatTimer = setInterval(() => {
          if (isClosed || request.signal?.aborted) {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            return;
          }
          const heartbeatFrame = formatSseEvent("heartbeat", {
            requestId,
            occurredAt: new Date().toISOString(),
          });
          safeEnqueue(heartbeatFrame);
        }, HEARTBEAT_INTERVAL_MS);

        // Disconnect listener
        if (request.signal) {
          request.signal.addEventListener("abort", () => {
            safeClose();
          });
        }

        const progressSink: AssistantProgressSink = {
          emit(event: SafeAssistantProgressEvent) {
            const frame = formatSseEvent("progress", event);
            safeEnqueue(frame);
          },
        };

        try {
          const result = await service.chat(body, {
            progressSink,
            signal: request.signal,
            requestId,
          });

          // Exactly one final event
          const finalFrame = formatSseEvent("final", { data: result });
          safeEnqueue(finalFrame);
        } catch {
          if (!request.signal?.aborted) {
            const errorResult = {
              conversationId:
                body.conversationId ?? `conv-${crypto.randomUUID()}`,
              message: "I couldn’t complete that request safely.",
              status: "FAILED",
              providerStatus: "UNKNOWN_PROVIDER_FAILURE",
              modelSelection: {
                provider: "autodo",
                model: "deterministic",
                fallbackUsed: false,
                taskClass: "SIMPLE_GENERAL",
                reasonCode: "STREAM_ERROR",
              },
              sessionId: null,
              executionId: null,
              verification: "UNKNOWN",
              decisionSummary: [
                "An unhandled error occurred during stream execution.",
                "No external action was performed.",
              ],
              telemetry: {
                totalDurationMs: 0,
                ai: [],
              },
            };
            const finalFrame = formatSseEvent("final", { data: errorResult });
            safeEnqueue(finalFrame);
          }
        } finally {
          safeClose();
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  };
}

export async function POST(request: Request) {
  return createAssistantChatStreamPostHandler(
    createDefaultAssistantChatService(),
  )(request);
}
