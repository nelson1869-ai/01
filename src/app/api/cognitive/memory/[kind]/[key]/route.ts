import {
  apiError,
  apiSuccess,
  handleRouteError,
} from "../../../../../../features/cognitive/api/api-response";
import { identifierParamSchema } from "../../../../../../features/cognitive/api/cue-api-contracts";
import { getDatabaseContext } from "../../../../../../features/cognitive/persistence/postgres/database";
import { memoryRepository } from "../../../../../../features/cognitive/persistence/postgres/repositories/memory-repository";

export async function GET(
  _request: Request,
  props: { params: Promise<{ kind: string; key: string }> },
) {
  try {
    const params = await props.params;
    const kind = identifierParamSchema.parse(params.kind);
    const key = identifierParamSchema.parse(params.key);

    const dbContext = getDatabaseContext();
    const head = await memoryRepository.findMemoryHead(
      dbContext.db,
      kind,
      key,
    );

    if (!head) {
      return apiError(
        "NOT_FOUND",
        `Verified memory head for kind "${kind}" and key "${key}" was not found.`,
        404,
      );
    }

    const fullMemory = await memoryRepository.findMemoryById(
      dbContext.db,
      head.memoryId,
    );

    return apiSuccess({
      memoryHead: {
        memoryId: head.memoryId,
        kind,
        key,
        version: head.memoryVersion,
        rowVersion: head.rowVersion,
        updatedAt: head.updatedAt,
        confidence: fullMemory?.confidence ?? 1.0,
        content: fullMemory?.content ?? {},
        sourceIds: fullMemory?.sourceIds ?? [],
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
