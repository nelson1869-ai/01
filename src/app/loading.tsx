export default function Loading() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6 bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      <div className="flex flex-col items-center gap-4">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-900 dark:border-zinc-700 dark:border-t-zinc-100" />
        <p className="text-xs font-medium tracking-wide uppercase text-zinc-500 dark:text-zinc-400">
          Loading AutoDo AI...
        </p>
      </div>
    </main>
  );
}
