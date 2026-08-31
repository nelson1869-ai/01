import LearningConsole from "./_components/learning-console";
import { readDashboardSnapshot } from "../features/cognitive/api/dashboard-read-model";
import { getDatabaseContext } from "../features/cognitive/persistence/postgres/database";

export const dynamic = "force-dynamic";

async function loadInitialSnapshot() {
  try {
    const { db } = getDatabaseContext();
    return await readDashboardSnapshot(db);
  } catch {
    return null;
  }
}

export default async function HomePage() {
  return <LearningConsole initialSnapshot={await loadInitialSnapshot()} />;
}
