export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6 bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      <div className="w-full max-w-3xl space-y-8 text-center sm:text-left">
        <div className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs font-medium text-zinc-700 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          AutoDo AI Architecture Baseline
        </div>

        <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">
          AutoDo AI
        </h1>

        <p className="text-lg text-zinc-600 dark:text-zinc-400 max-w-2xl">
          Autonomous execution platform built on a verified cognitive cycle.
          Engineered for deterministic grounding, policy-bound planning, and
          durable actions.
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 pt-4">
          <div className="rounded-xl border border-zinc-200 bg-white p-5 text-left shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">
              Perception & Memory
            </h2>
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              Context assembly, multi-tier retrieval, and temporal grounding.
            </p>
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white p-5 text-left shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">
              Policy & Planning
            </h2>
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              Candidate scoring, safety boundary validation, and execution
              graphs.
            </p>
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white p-5 text-left shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">
              Durable Execution
            </h2>
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              State checkpointing, verification feedback loops, and audit
              ledgers.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
