import {
  apiError,
  apiSuccess,
  handleRouteError,
} from "../../../../../features/cognitive/api/api-response";
import { identifierParamSchema } from "../../../../../features/cognitive/api/cue-api-contracts";
import { getDatabaseContext } from "../../../../../features/cognitive/persistence/postgres/database";
import { learningRepository } from "../../../../../features/cognitive/persistence/postgres/repositories/learning-repository";

export async function GET(
  _request: Request,
  props: { params: Promise<{ skillKey: string }> },
) {
  try {
    const params = await props.params;
    const skillKey = identifierParamSchema.parse(params.skillKey);

    const dbContext = getDatabaseContext();
    const learning = await learningRepository.findLearningState(
      dbContext.db,
      skillKey,
    );

    if (!learning) {
      return apiError(
        "NOT_FOUND",
        `Learning state for skill "${skillKey}" was not found.`,
        404,
      );
    }

    return apiSuccess({
      learningState: {
        skillKey: learning.skillKey,
        confidence: learning.confidence,
        totalReward: learning.totalReward,
        sampleCount: learning.sampleCount,
        rowVersion: learning.rowVersion,
        updatedAt: learning.updatedAt,
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
