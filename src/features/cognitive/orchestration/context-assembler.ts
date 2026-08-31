import type { PersistedCognitiveSession } from "../persistence/contracts/cognitive-session";
import type { PersistedCueIngress } from "../persistence/contracts/cue-ingress";
import type { MemoryKind } from "../domain/memory";
import type { PersistedVerifiedMemory } from "../persistence/contracts/verified-memory";
import { PersistenceError } from "../persistence/postgres/errors/persistence-errors";
import {
  type PersistedLearningState,
  learningRepository,
} from "../persistence/postgres/repositories/learning-repository";
import type { DatabaseClient } from "../persistence/postgres/transactions/transaction-executor";
import { retrieveMemoryHeadsBatch } from "./memory-retrieval-orchestrator";

const DISALLOWED_CONTEXT_SECRET_KEYS_PATTERN =
  /^(authorization|accesstoken|refreshtoken|apikey|password|cookie|privatekey|secret|token|authbrand|runtimeauthorization|chainofthought|scratchpad|hiddenreasoning|modelthoughts|rawmodeltrace)$/i;

export function assertContextSecurity(data: unknown, path: string = ""): void {
  if (data === null || typeof data !== "object") {
    return;
  }

  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      assertContextSecurity(data[i], `${path}[${i}]`);
    }
    return;
  }

  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (DISALLOWED_CONTEXT_SECRET_KEYS_PATTERN.test(key)) {
      throw PersistenceError.invalidPersistedState(
        `Disallowed property "${key}" (secret, credential, brand, or chain-of-thought) found in cognitive context at ${path || "root"}.`,
      );
    }
    assertContextSecurity(value, path ? `${path}.${key}` : key);
  }
}

export interface PerceptionResult {
  readonly summary: string;
  readonly structuredFacts: Readonly<Record<string, unknown>>;
  readonly perceivedAt: string;
}

export interface MemoryHeadRequest {
  readonly kind: MemoryKind;
  readonly memoryKey: string;
}

export interface AssembledCognitiveContext {
  readonly cue: PersistedCueIngress;
  readonly session: PersistedCognitiveSession;
  readonly perception: PerceptionResult;
  readonly verifiedMemories: readonly PersistedVerifiedMemory[];
  readonly learningState: PersistedLearningState;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AssembleContextParams {
  readonly session: PersistedCognitiveSession;
  readonly cue: PersistedCueIngress;
  readonly perception: PerceptionResult;
  readonly skillKey: string;
  readonly memoryRequests?: readonly MemoryHeadRequest[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export async function assembleCognitiveContext(
  db: DatabaseClient,
  params: AssembleContextParams,
): Promise<AssembledCognitiveContext> {
  // 1. Validate security of incoming perception and metadata
  assertContextSecurity(params.perception);
  if (params.metadata) {
    assertContextSecurity(params.metadata);
  }

  // 2. Retrieve explicit verified memory heads
  const requests = params.memoryRequests ?? [];
  const verifiedMemories =
    requests.length > 0 ? await retrieveMemoryHeadsBatch(db, requests) : [];

  // 3. Retrieve learning state for explicit skillKey (or use neutral advisory state)
  const existingLearning = await learningRepository.findLearningState(
    db,
    params.skillKey,
  );

  const learningState: PersistedLearningState = existingLearning ?? {
    skillKey: params.skillKey,
    confidence: 0.5,
    totalReward: 0,
    sampleCount: 0,
    rowVersion: 0,
    updatedAt: params.session.updatedAt,
  };

  const context: AssembledCognitiveContext = {
    cue: params.cue,
    session: params.session,
    perception: params.perception,
    verifiedMemories,
    learningState,
    metadata: params.metadata ?? {},
  };

  // 4. Validate complete assembled context against disallowed secrets/brands
  assertContextSecurity(context);

  return context;
}
