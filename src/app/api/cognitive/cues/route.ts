import {
  apiCreated,
  apiError,
  apiSuccess,
  handleRouteError,
} from "../../../../features/cognitive/api/api-response";
import {
  createCueRequestSchema,
  identifierParamSchema,
  type IngestedCueResponseData,
} from "../../../../features/cognitive/api/cue-api-contracts";
import type { JSONObject } from "../../../../features/cognitive/adapters/adapter-contract";
import type { PersistedCueIngress } from "../../../../features/cognitive/persistence/contracts/cue-ingress";
import { getDatabaseContext } from "../../../../features/cognitive/persistence/postgres/database";
import { ingestCue } from "../../../../features/cognitive/persistence/postgres/transactions/ingest-cue";

export async function POST(request: Request) {
  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON.", 400);
  }

  try {
    const body = createCueRequestSchema.parse(rawBody);

    // Optional Idempotency-Key header validation
    const rawIdempotencyKey = request.headers.get("idempotency-key");
    let idempotencyKey: string | null = null;
    if (rawIdempotencyKey) {
      idempotencyKey = identifierParamSchema.parse(rawIdempotencyKey.trim());
    }

    const receivedAt = new Date().toISOString();
    const occurredAt = body.occurredAt ?? receivedAt;
    const externalEventId =
      body.externalEventId ??
      (idempotencyKey ? `idemp:${idempotencyKey}` : `evt-${crypto.randomUUID()}`);
    const cueId = `cue-${crypto.randomUUID()}`;
    const sessionId = `sess-${crypto.randomUUID()}`;

    const persistedCue: PersistedCueIngress = {
      cueId,
      source: body.source,
      externalEventId,
      type: body.type,
      occurredAt,
      receivedAt,
      payload: body.payload as JSONObject,
    };

    const dbContext = getDatabaseContext();
    const ingestResult = await ingestCue(dbContext.db, {
      cue: persistedCue,
      sessionId,
      maxRetries: body.maxRetries,
    });

    const responseData: IngestedCueResponseData = {
      cue: ingestResult.cue,
      session: ingestResult.session,
    };

    // Return 200 OK on idempotent replay, 201 Created on fresh insertion
    if (ingestResult.isReplay) {
      return apiSuccess(responseData, 200);
    }

    return apiCreated(responseData);
  } catch (error) {
    return handleRouteError(error);
  }
}
