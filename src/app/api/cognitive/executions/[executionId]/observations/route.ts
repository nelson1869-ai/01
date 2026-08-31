import {
  apiSuccess,
  handleRouteError,
} from "../../../../../../features/cognitive/api/api-response";
import { identifierParamSchema } from "../../../../../../features/cognitive/api/cue-api-contracts";
import { getDatabaseContext } from "../../../../../../features/cognitive/persistence/postgres/database";
import { observationRepository } from "../../../../../../features/cognitive/persistence/postgres/repositories/observation-repository";

export async function GET(
  _request: Request,
  props: { params: Promise<{ executionId: string }> },
) {
  try {
    const params = await props.params;
    const executionId = identifierParamSchema.parse(params.executionId);

    const dbContext = getDatabaseContext();
    const rows = await observationRepository.findManyObservationsByExecutionId(
      dbContext.db,
      executionId,
    );

    // Stable deterministic sort by observedAt asc, then observationId asc
    const sorted = [...rows].sort((a, b) => {
      const cmp = a.observedAt.localeCompare(b.observedAt);
      if (cmp !== 0) return cmp;
      return a.observationId.localeCompare(b.observationId);
    });

    // Bound maximum returned items to 50
    const bounded = sorted.slice(0, 50).map((obs) => ({
      observationId: obs.observationId,
      executionId: obs.executionId,
      stepId: obs.stepId,
      source: obs.source,
      sourceEventId: obs.sourceEventId,
      summary: obs.summary,
      data: obs.data,
      observedAt: obs.observedAt,
    }));

    return apiSuccess({
      observations: bounded,
      count: bounded.length,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
