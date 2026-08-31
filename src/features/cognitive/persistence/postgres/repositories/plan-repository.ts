import { and, asc, eq } from "drizzle-orm";

import type { PersistedActionPlan } from "../../contracts/persisted-action-plan";
import { PersistenceError } from "../errors/persistence-errors";
import {
  actionPlans,
  actionPlanStepDependencies,
  actionPlanSteps,
} from "../schema/planning";
import {
  type DatabaseExecutor,
  runInTransaction,
} from "../transactions/transaction-executor";
import { createCanonicalFingerprint } from "../utils/canonical-fingerprint";
import { decodeActionPlanRow } from "../utils/row-mappers";

function planContentHash(plan: PersistedActionPlan): string {
  return createCanonicalFingerprint({
    candidateId: plan.candidateId,
    planGeneration: plan.planGeneration,
    steps: plan.steps.map((s) => ({
      stepId: s.stepId,
      ordinal: s.ordinal,
      description: s.description,
    })),
    dependencies: plan.dependencies.map((d) => ({
      stepId: d.stepId,
      dependsOnStepId: d.dependsOnStepId,
    })),
  });
}

export class PlanRepository {
  async findPlanById(
    executor: DatabaseExecutor,
    planId: string,
  ): Promise<PersistedActionPlan | null> {
    const planRows = await executor
      .select()
      .from(actionPlans)
      .where(eq(actionPlans.planId, planId))
      .limit(1);

    if (planRows.length === 0) {
      return null;
    }

    const stepRows = await executor
      .select()
      .from(actionPlanSteps)
      .where(eq(actionPlanSteps.planId, planId))
      .orderBy(asc(actionPlanSteps.ordinal));

    const depRows = await executor
      .select()
      .from(actionPlanStepDependencies)
      .where(eq(actionPlanStepDependencies.planId, planId));

    return decodeActionPlanRow(planRows[0], stepRows, depRows);
  }

  async findPlanByCandidateId(
    executor: DatabaseExecutor,
    candidateId: string,
  ): Promise<PersistedActionPlan | null> {
    const planRows = await executor
      .select()
      .from(actionPlans)
      .where(eq(actionPlans.candidateId, candidateId))
      .orderBy(asc(actionPlans.planGeneration))
      .limit(1);

    if (planRows.length === 0) {
      return null;
    }

    const stepRows = await executor
      .select()
      .from(actionPlanSteps)
      .where(eq(actionPlanSteps.planId, planRows[0].planId))
      .orderBy(asc(actionPlanSteps.ordinal));

    const depRows = await executor
      .select()
      .from(actionPlanStepDependencies)
      .where(eq(actionPlanStepDependencies.planId, planRows[0].planId));

    return decodeActionPlanRow(planRows[0], stepRows, depRows);
  }

  async findPlanByCandidateAndGeneration(
    executor: DatabaseExecutor,
    candidateId: string,
    planGeneration: number,
  ): Promise<PersistedActionPlan | null> {
    const planRows = await executor
      .select()
      .from(actionPlans)
      .where(
        and(
          eq(actionPlans.candidateId, candidateId),
          eq(actionPlans.planGeneration, planGeneration),
        ),
      )
      .limit(1);

    if (planRows.length === 0) {
      return null;
    }

    const stepRows = await executor
      .select()
      .from(actionPlanSteps)
      .where(eq(actionPlanSteps.planId, planRows[0].planId))
      .orderBy(asc(actionPlanSteps.ordinal));

    const depRows = await executor
      .select()
      .from(actionPlanStepDependencies)
      .where(eq(actionPlanStepDependencies.planId, planRows[0].planId));

    return decodeActionPlanRow(planRows[0], stepRows, depRows);
  }

  async appendPlan(
    executor: DatabaseExecutor,
    plan: PersistedActionPlan,
  ): Promise<{ isReplay: boolean; plan: PersistedActionPlan }> {
    const incomingHash = planContentHash(plan);

    return await runInTransaction(executor, async (tx) => {
      const insertedRows = await tx
        .insert(actionPlans)
        .values({
          planId: plan.planId,
          candidateId: plan.candidateId,
          planGeneration: plan.planGeneration,
          createdAt: plan.createdAt,
        })
        .onConflictDoNothing()
        .returning();

      if (insertedRows.length > 0) {
        for (const step of plan.steps) {
          await tx.insert(actionPlanSteps).values({
            planId: plan.planId,
            stepId: step.stepId,
            ordinal: step.ordinal,
            description: step.description,
          });
        }

        for (const dep of plan.dependencies) {
          await tx.insert(actionPlanStepDependencies).values({
            planId: plan.planId,
            stepId: dep.stepId,
            dependsOnStepId: dep.dependsOnStepId,
          });
        }

        return {
          isReplay: false,
          plan: decodeActionPlanRow(
            insertedRows[0],
            plan.steps,
            plan.dependencies,
          ),
        };
      }

      // Conflict: find existing
      const existing =
        (await this.findPlanById(tx, plan.planId)) ??
        (await this.findPlanByCandidateAndGeneration(
          tx,
          plan.candidateId,
          plan.planGeneration,
        ));

      if (!existing) {
        throw PersistenceError.invalidPersistedState(
          `Failed to find existing plan "${plan.planId}".`,
        );
      }

      const existingHash = planContentHash(existing);

      if (incomingHash !== existingHash) {
        throw PersistenceError.idempotencyConflict(
          `Plan for candidate "${plan.candidateId}" and generation ${plan.planGeneration} already exists with different contents.`,
          {
            planId: plan.planId,
            incomingHash,
            existingHash,
          },
        );
      }

      return {
        isReplay: true,
        plan: existing,
      };
    });
  }
}

export const planRepository = new PlanRepository();
