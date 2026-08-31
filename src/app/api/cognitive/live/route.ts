import { readDashboardSnapshot } from "../../../../features/cognitive/api/dashboard-read-model";
import { getDatabaseContext } from "../../../../features/cognitive/persistence/postgres/database";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REFRESH_INTERVAL_MS = 4_000;

function frame(event: string, data: unknown, id?: number): string {
  return `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(request: Request): Promise<Response> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let sequence = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const close = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        try {
          controller.close();
        } catch {
          // The browser may already have closed the stream.
        }
      };

      const send = (event: string, data: unknown) => {
        if (closed || request.signal.aborted) return;
        sequence += 1;
        controller.enqueue(encoder.encode(frame(event, data, sequence)));
      };

      const publish = async () => {
        if (closed || request.signal.aborted) return close();
        try {
          const { db } = getDatabaseContext();
          send("snapshot", await readDashboardSnapshot(db));
        } catch {
          send("unavailable", {
            message: "The cognitive database is not available.",
            occurredAt: new Date().toISOString(),
          });
        }
        if (!closed) timer = setTimeout(publish, REFRESH_INTERVAL_MS);
      };

      request.signal.addEventListener("abort", close, { once: true });
      await publish();
    },
    cancel() {
      // Abort propagation from the request closes the producer.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
