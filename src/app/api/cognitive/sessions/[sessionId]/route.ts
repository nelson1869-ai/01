import {
  apiError,
  apiSuccess,
  handleRouteError,
} from "../../../../../features/cognitive/api/api-response";
import { identifierParamSchema } from "../../../../../features/cognitive/api/cue-api-contracts";
import { getDatabaseContext } from "../../../../../features/cognitive/persistence/postgres/database";
import { sessionRepository } from "../../../../../features/cognitive/persistence/postgres/repositories/session-repository";

export async function GET(
  _request: Request,
  props: { params: Promise<{ sessionId: string }> },
) {
  try {
    const params = await props.params;
    const sessionId = identifierParamSchema.parse(params.sessionId);

    const dbContext = getDatabaseContext();
    const session = await sessionRepository.findSessionById(dbContext.db, sessionId);

    if (!session) {
      return apiError("NOT_FOUND", `Session "${sessionId}" was not found.`, 404);
    }

    return apiSuccess({ session });
  } catch (error) {
    return handleRouteError(error);
  }
}
