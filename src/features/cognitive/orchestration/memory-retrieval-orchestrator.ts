import type { MemoryKind } from "../domain/memory";
import type { PersistedVerifiedMemory } from "../persistence/contracts/verified-memory";
import { memoryRepository } from "../persistence/postgres/repositories/memory-repository";
import type { DatabaseClient } from "../persistence/postgres/transactions/transaction-executor";

export interface MemoryRetrievalRequest {
  readonly kind: MemoryKind;
  readonly memoryKey: string;
}

export async function retrieveMemoryHead(
  db: DatabaseClient,
  params: MemoryRetrievalRequest,
): Promise<PersistedVerifiedMemory | null> {
  const head = await memoryRepository.findMemoryHead(
    db,
    params.kind,
    params.memoryKey,
  );
  if (!head) {
    return null;
  }

  return await memoryRepository.findMemoryById(db, head.memoryId);
}

export async function retrieveMemoryHeadsBatch(
  db: DatabaseClient,
  requests: readonly MemoryRetrievalRequest[],
): Promise<PersistedVerifiedMemory[]> {
  if (requests.length === 0) {
    return [];
  }

  // Deduplicate requested keys deterministically
  const seen = new Set<string>();
  const uniqueRequests: MemoryRetrievalRequest[] = [];

  for (const req of requests) {
    const compositeKey = `${req.kind}:${req.memoryKey}`;
    if (!seen.has(compositeKey)) {
      seen.add(compositeKey);
      uniqueRequests.push(req);
    }
  }

  const results: PersistedVerifiedMemory[] = [];

  for (const req of uniqueRequests) {
    const memory = await retrieveMemoryHead(db, req);
    if (memory) {
      results.push(memory);
    }
  }

  // Deterministic ordering: kind ASC, key ASC
  results.sort((a, b) => {
    const kindComp = a.kind.localeCompare(b.kind);
    if (kindComp !== 0) {
      return kindComp;
    }
    return a.key.localeCompare(b.key);
  });

  return results;
}

export async function retrieveHistoricalMemoryVersion(
  db: DatabaseClient,
  params: {
    readonly kind: MemoryKind;
    readonly memoryKey: string;
    readonly version: number;
  },
): Promise<PersistedVerifiedMemory | null> {
  return await memoryRepository.findMemoryByKindKeyAndVersion(
    db,
    params.kind,
    params.memoryKey,
    params.version,
  );
}
