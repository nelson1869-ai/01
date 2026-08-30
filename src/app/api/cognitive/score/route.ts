import { scoreCandidateRequestSchema } from "@/features/cognitive/api/score-request";
import { scoreCandidate } from "@/features/cognitive/domain/candidate-score";

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json(
      {
        error: "INVALID_JSON",
      },
      {
        status: 400,
      },
    );
  }

  const result = scoreCandidateRequestSchema.safeParse(body);

  if (!result.success) {
    return Response.json(
      {
        error: "VALIDATION_ERROR",
        issues: result.error.issues,
      },
      {
        status: 400,
      },
    );
  }

  const score = scoreCandidate(result.data);

  return Response.json(
    {
      data: score,
    },
    {
      status: 200,
    },
  );
}
