import {
  apiError,
  apiSuccess,
  handleRouteError,
} from "../../../../../../features/cognitive/api/api-response";
import { identifierParamSchema } from "../../../../../../features/cognitive/api/cue-api-contracts";
import { getDatabaseContext } from "../../../../../../features/cognitive/persistence/postgres/database";
import { safetyRepository } from "../../../../../../features/cognitive/persistence/postgres/repositories/safety-repository";
import { sessionRepository } from "../../../../../../features/cognitive/persistence/postgres/repositories/session-repository";

export async function GET(
  _request: Request,
  props: { params: Promise<{ sessionId: string }> },
) {
  try {
    const params = await props.params;
    const sessionId = identifierParamSchema.parse(params.sessionId);

    const dbContext = getDatabaseContext();
    const session = await sessionRepository.findSessionById(
      dbContext.db,
      sessionId,
    );

    if (!session) {
      return apiError(
        "NOT_FOUND",
        `Cognitive session "${sessionId}" was not found.`,
        404,
      );
    }

    const safety = await safetyRepository.findSafetyStateBySessionId(
      dbContext.db,
      sessionId,
    );

    const reviewRequired =
      session.phase === "HUMAN_REVIEW" || safety?.status === "BLOCKED";

    let reason: string | null = null;
    if (session.phase === "HUMAN_REVIEW") {
      reason = "Session phase requires human operator confirmation or intervention.";
    } else if (safety?.status === "BLOCKED") {
      reason = "Session safety state is permanently BLOCKED.";
    }

    return apiSuccess({
      humanReview: {
        reviewRequired,
        sessionId: session.sessionId,
        phase: session.phase,
        candidateId: session.currentCandidateId,
        safetyStatus: safety?.status ?? "HEALTHY",
        reason,
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
