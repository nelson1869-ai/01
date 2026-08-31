import {
  apiError,
  apiSuccess,
  handleRouteError,
} from "../../../../../../features/cognitive/api/api-response";
import { identifierParamSchema } from "../../../../../../features/cognitive/api/cue-api-contracts";
import {
  runSessionRequestSchema,
  type RunSessionResponseData,
} from "../../../../../../features/cognitive/api/session-run-contracts";
import { executeSessionCycle } from "../../../../../../features/cognitive/api/runtime-composition";
import { getDatabaseContext } from "../../../../../../features/cognitive/persistence/postgres/database";

export async function POST(
  request: Request,
  props: { params: Promise<{ sessionId: string }> },
) {
  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON.", 400);
  }

  try {
    const params = await props.params;
    const sessionId = identifierParamSchema.parse(params.sessionId);
    const body = runSessionRequestSchema.parse(rawBody);

    const dbContext = getDatabaseContext();
    const cycleOutcome = await executeSessionCycle(dbContext.db, sessionId, {
      taskProfile: body.taskProfile,
    });

    const responseData: RunSessionResponseData = {
      result: cycleOutcome.result,
      session: cycleOutcome.session,
    };

    return apiSuccess(responseData, 200);
  } catch (error) {
    return handleRouteError(error);
  }
}
