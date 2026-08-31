import { and, eq } from "drizzle-orm";

import type { PersistedPolicyDecision } from "../../contracts/persisted-policy-decision";
import { PersistenceError } from "../errors/persistence-errors";
import { policyDecisionPolicyRefs, policyDecisions } from "../schema/decisions";
import {
  type DatabaseExecutor,
  runInTransaction,
} from "../transactions/transaction-executor";
import { createCanonicalFingerprint } from "../utils/canonical-fingerprint";
import { decodePolicyDecisionRow } from "../utils/row-mappers";

function policyContentHash(decision: PersistedPolicyDecision): string {
  return createCanonicalFingerprint({
    candidateId: decision.candidateId,
    groundingResultId: decision.groundingResultId,
    evaluationKey: decision.evaluationKey,
    outcome: decision.outcome,
    reason: decision.reason,
    policyEngineVersion: decision.policyEngineVersion,
    policyIds: [...decision.policyIds].sort(),
  });
}

export class PolicyRepository {
  async findPolicyDecisionById(
    executor: DatabaseExecutor,
    policyDecisionId: string,
  ): Promise<PersistedPolicyDecision | null> {
    const rows = await executor
      .select()
      .from(policyDecisions)
      .where(eq(policyDecisions.policyDecisionId, policyDecisionId))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    const refRows = await executor
      .select({ policyId: policyDecisionPolicyRefs.policyId })
      .from(policyDecisionPolicyRefs)
      .where(eq(policyDecisionPolicyRefs.policyDecisionId, policyDecisionId));

    const policyIds = refRows.map((r) => r.policyId);

    return decodePolicyDecisionRow(rows[0], policyIds);
  }

  async findPolicyDecisionByCandidateId(
    executor: DatabaseExecutor,
    candidateId: string,
  ): Promise<PersistedPolicyDecision | null> {
    const rows = await executor
      .select()
      .from(policyDecisions)
      .where(eq(policyDecisions.candidateId, candidateId))
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    const refRows = await executor
      .select({ policyId: policyDecisionPolicyRefs.policyId })
      .from(policyDecisionPolicyRefs)
      .where(
        eq(policyDecisionPolicyRefs.policyDecisionId, rows[0].policyDecisionId),
      );

    const policyIds = refRows.map((r) => r.policyId);

    return decodePolicyDecisionRow(rows[0], policyIds);
  }

  async findPolicyDecisionByCandidateAndKey(
    executor: DatabaseExecutor,
    candidateId: string,
    evaluationKey: string,
  ): Promise<PersistedPolicyDecision | null> {
    const rows = await executor
      .select()
      .from(policyDecisions)
      .where(
        and(
          eq(policyDecisions.candidateId, candidateId),
          eq(policyDecisions.evaluationKey, evaluationKey),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      return null;
    }

    const refRows = await executor
      .select({ policyId: policyDecisionPolicyRefs.policyId })
      .from(policyDecisionPolicyRefs)
      .where(
        eq(policyDecisionPolicyRefs.policyDecisionId, rows[0].policyDecisionId),
      );

    const policyIds = refRows.map((r) => r.policyId);

    return decodePolicyDecisionRow(rows[0], policyIds);
  }

  async appendPolicyDecision(
    executor: DatabaseExecutor,
    decision: PersistedPolicyDecision,
  ): Promise<{ isReplay: boolean; decision: PersistedPolicyDecision }> {
    const incomingHash = policyContentHash(decision);

    return await runInTransaction(executor, async (tx) => {
      const insertedRows = await tx
        .insert(policyDecisions)
        .values({
          policyDecisionId: decision.policyDecisionId,
          candidateId: decision.candidateId,
          groundingResultId: decision.groundingResultId,
          evaluationKey: decision.evaluationKey,
          outcome: decision.outcome,
          reason: decision.reason,
          policyEngineVersion: decision.policyEngineVersion,
          evaluatedAt: decision.evaluatedAt,
        })
        .onConflictDoNothing()
        .returning();

      if (insertedRows.length > 0) {
        if (decision.policyIds.length > 0) {
          for (const policyId of decision.policyIds) {
            await tx.insert(policyDecisionPolicyRefs).values({
              policyDecisionId: decision.policyDecisionId,
              policyId,
            });
          }
        }

        return {
          isReplay: false,
          decision: decodePolicyDecisionRow(
            insertedRows[0],
            decision.policyIds,
          ),
        };
      }

      // Conflict: find existing
      const existing =
        (await this.findPolicyDecisionById(tx, decision.policyDecisionId)) ??
        (await this.findPolicyDecisionByCandidateAndKey(
          tx,
          decision.candidateId,
          decision.evaluationKey,
        ));

      if (!existing) {
        throw PersistenceError.invalidPersistedState(
          `Failed to find existing policy decision "${decision.policyDecisionId}".`,
        );
      }

      const existingHash = policyContentHash(existing);

      if (incomingHash !== existingHash) {
        throw PersistenceError.idempotencyConflict(
          `Policy decision for candidate "${decision.candidateId}" and key "${decision.evaluationKey}" already exists with different contents.`,
          {
            policyDecisionId: decision.policyDecisionId,
            incomingHash,
            existingHash,
          },
        );
      }

      return {
        isReplay: true,
        decision: existing,
      };
    });
  }
}

export const policyRepository = new PolicyRepository();
