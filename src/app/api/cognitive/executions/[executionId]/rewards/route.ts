import {
  apiSuccess,
  handleRouteError,
} from "../../../../../../features/cognitive/api/api-response";
import { identifierParamSchema } from "../../../../../../features/cognitive/api/cue-api-contracts";
import { getDatabaseContext } from "../../../../../../features/cognitive/persistence/postgres/database";
import { rewardRepository } from "../../../../../../features/cognitive/persistence/postgres/repositories/reward-repository";

export async function GET(
  _request: Request,
  props: { params: Promise<{ executionId: string }> },
) {
  try {
    const params = await props.params;
    const executionId = identifierParamSchema.parse(params.executionId);

    const dbContext = getDatabaseContext();
    const rows = await rewardRepository.findRewardsByExecutionId(
      dbContext.db,
      executionId,
    );

    const bounded = rows.slice(0, 50).map((r) => ({
      rewardEventId: r.rewardEventId,
      executionId: r.executionId,
      verificationId: r.verificationId,
      rewardRuleId: r.rewardRuleId,
      rewardIdempotencyKey: r.rewardIdempotencyKey,
      signal: r.signal,
      value: r.value,
      reason: r.reason,
      createdAt: r.createdAt,
    }));

    return apiSuccess({
      rewards: bounded,
      count: bounded.length,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
