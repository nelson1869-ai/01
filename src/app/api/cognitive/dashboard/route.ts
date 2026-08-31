import { apiSuccess, handleRouteError } from "../../../../features/cognitive/api/api-response";
import { readDashboardSnapshot } from "../../../../features/cognitive/api/dashboard-read-model";
import { getDatabaseContext } from "../../../../features/cognitive/persistence/postgres/database";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { db } = getDatabaseContext();
    return apiSuccess(await readDashboardSnapshot(db));
  } catch (error) {
    return handleRouteError(error);
  }
}
