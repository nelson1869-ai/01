import {
  apiError,
  apiSuccess,
  handleRouteError,
} from "../../../../../features/cognitive/api/api-response";
import { identifierParamSchema } from "../../../../../features/cognitive/api/cue-api-contracts";
import { getDatabaseContext } from "../../../../../features/cognitive/persistence/postgres/database";
import { cueRepository } from "../../../../../features/cognitive/persistence/postgres/repositories/cue-repository";

export async function GET(
  _request: Request,
  props: { params: Promise<{ cueId: string }> },
) {
  try {
    const params = await props.params;
    const cueId = identifierParamSchema.parse(params.cueId);

    const dbContext = getDatabaseContext();
    const cue = await cueRepository.findCueById(dbContext.db, cueId);

    if (!cue) {
      return apiError("NOT_FOUND", `Cue "${cueId}" was not found.`, 404);
    }

    return apiSuccess({ cue });
  } catch (error) {
    return handleRouteError(error);
  }
}
