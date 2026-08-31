import {
  apiError,
  apiSuccess,
  handleRouteError,
} from "../../../../../features/cognitive/api/api-response";
import { identifierParamSchema } from "../../../../../features/cognitive/api/cue-api-contracts";
import { getDatabaseContext } from "../../../../../features/cognitive/persistence/postgres/database";
import { executionRepository } from "../../../../../features/cognitive/persistence/postgres/repositories/execution-repository";

export async function GET(
  _request: Request,
  props: { params: Promise<{ executionId: string }> },
) {
  try {
    const params = await props.params;
    const executionId = identifierParamSchema.parse(params.executionId);

    const dbContext = getDatabaseContext();
    const execution = await executionRepository.findExecutionById(
      dbContext.db,
      executionId,
    );

    if (!execution) {
      return apiError(
        "NOT_FOUND",
        `Execution "${executionId}" was not found.`,
        404,
      );
    }

    return apiSuccess({
      execution: {
        executionId: execution.executionId,
        sessionId: execution.sessionId,
        planId: execution.planId,
        status: execution.status,
        currentStepId: execution.currentStepId,
        startedAt: execution.startedAt,
        completedAt: execution.completedAt,
        error: execution.error,
        safetyGenerationAtStart: execution.safetyGenerationAtStart,
        rowVersion: execution.rowVersion,
        createdAt: execution.createdAt,
        updatedAt: execution.updatedAt,
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
