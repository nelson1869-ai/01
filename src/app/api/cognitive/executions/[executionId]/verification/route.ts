import {
  apiError,
  apiSuccess,
  handleRouteError,
} from "../../../../../../features/cognitive/api/api-response";
import { identifierParamSchema } from "../../../../../../features/cognitive/api/cue-api-contracts";
import { getDatabaseContext } from "../../../../../../features/cognitive/persistence/postgres/database";
import { verificationRepository } from "../../../../../../features/cognitive/persistence/postgres/repositories/verification-repository";

export async function GET(
  _request: Request,
  props: { params: Promise<{ executionId: string }> },
) {
  try {
    const params = await props.params;
    const executionId = identifierParamSchema.parse(params.executionId);

    const dbContext = getDatabaseContext();
    const verification =
      await verificationRepository.findLatestVerificationByExecutionId(
        dbContext.db,
        executionId,
      );

    if (!verification) {
      return apiError(
        "NOT_FOUND",
        `Verification for execution "${executionId}" was not found.`,
        404,
      );
    }

    const observationIds =
      await verificationRepository.findObservationIdsForVerification(
        dbContext.db,
        verification.verificationId,
      );

    return apiSuccess({
      verification: {
        verificationId: verification.verificationId,
        executionId: verification.executionId,
        verificationGeneration: verification.verificationGeneration,
        observationSetDigest: verification.observationSetDigest,
        verifierVersion: verification.verifierVersion,
        status: verification.status,
        confidence: verification.confidence,
        reason: verification.reason,
        observationIds,
        verifiedAt: verification.verifiedAt,
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
