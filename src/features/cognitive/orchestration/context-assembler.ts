import type { PersistedCognitiveSession } from "../persistence/contracts/cognitive-session";
import type { PersistedCueIngress } from "../persistence/contracts/cue-ingress";
import type { MemoryKind } from "../domain/memory";
import type { PersistedVerifiedMemory } from "../persistence/contracts/verified-memory";
import {
  type PersistedLearningState,
  learningRepository,
} from "../persistence/postgres/repositories/learning-repository";
import type { DatabaseClient } from "../persistence/postgres/transactions/transaction-executor";
import { retrieveMemoryHeadsBatch } from "./memory-retrieval-orchestrator";
import {
  type GitHubTargetSpec,
  gitHubTargetSpecSchema,
} from "../domain/target-spec";

import { assertDataSecurity } from "../security/secret-safety";

export function assertContextSecurity(data: unknown, path: string = ""): void {
  assertDataSecurity(data, path);
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
  readonly targetSpec: GitHubTargetSpec;
  readonly verifiedMemories: readonly PersistedVerifiedMemory[];
  readonly learningState: PersistedLearningState;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AssembleContextParams {
  readonly session: PersistedCognitiveSession;
  readonly cue: PersistedCueIngress;
  readonly perception: PerceptionResult;
  readonly targetSpec: GitHubTargetSpec;
  readonly skillKey: string;
  readonly memoryRequests?: readonly MemoryHeadRequest[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export async function assembleCognitiveContext(
  db: DatabaseClient,
  params: AssembleContextParams,
): Promise<AssembledCognitiveContext> {
  // 1. Validate security of incoming perception, targetSpec, and metadata
  assertContextSecurity(params.perception);
  const validatedTargetSpec = gitHubTargetSpecSchema.parse(params.targetSpec);
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
    targetSpec: validatedTargetSpec,
    verifiedMemories,
    learningState,
    metadata: params.metadata ?? {},
  };

  // 4. Validate complete assembled context against disallowed secrets/brands
  assertContextSecurity(context);

  return context;
}
