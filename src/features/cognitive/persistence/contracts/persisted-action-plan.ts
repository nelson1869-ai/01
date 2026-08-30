import { z } from "zod";

import {
  identifierSchema,
  nonNegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
  summarySchema,
  timestampSchema,
} from "./primitives";

export const persistedActionPlanStepSchema = z
  .strictObject({
    stepId: identifierSchema,
    ordinal: nonNegativeSafeIntegerSchema,
    description: summarySchema,
  })
  .readonly();

export type PersistedActionPlanStep = z.infer<
  typeof persistedActionPlanStepSchema
>;

export const persistedActionPlanStepDependencySchema = z
  .strictObject({
    stepId: identifierSchema,
    dependsOnStepId: identifierSchema,
  })
  .refine(
    (dep) => dep.stepId !== dep.dependsOnStepId,
    "Step cannot depend on itself.",
  )
  .readonly();

export type PersistedActionPlanStepDependency = z.infer<
  typeof persistedActionPlanStepDependencySchema
>;

export const persistedActionPlanSchema = z
  .strictObject({
    planId: identifierSchema,
    candidateId: identifierSchema,
    planGeneration: positiveSafeIntegerSchema,
    steps: z.array(persistedActionPlanStepSchema).min(1).max(500).readonly(),
    dependencies: z
      .array(persistedActionPlanStepDependencySchema)
      .max(1_000)
      .readonly(),
    createdAt: timestampSchema,
  })
  .superRefine((plan, context) => {
    const stepIds = new Set(plan.steps.map((s) => s.stepId));

    for (let i = 0; i < plan.dependencies.length; i++) {
      const dep = plan.dependencies[i];
      if (!stepIds.has(dep.stepId)) {
        context.addIssue({
          code: "custom",
          message: `Dependency stepId "${dep.stepId}" does not exist in plan steps.`,
          path: ["dependencies", i, "stepId"],
        });
      }
      if (!stepIds.has(dep.dependsOnStepId)) {
        context.addIssue({
          code: "custom",
          message: `Dependency dependsOnStepId "${dep.dependsOnStepId}" does not exist in plan steps.`,
          path: ["dependencies", i, "dependsOnStepId"],
        });
      }
    }
  })
  .readonly();

export type PersistedActionPlan = z.infer<typeof persistedActionPlanSchema>;
