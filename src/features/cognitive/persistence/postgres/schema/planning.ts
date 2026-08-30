import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

import { candidateActions } from "./decisions";

export const actionPlans = pgTable(
  "action_plans",
  {
    planId: varchar("plan_id", { length: 256 }).primaryKey(),
    candidateId: varchar("candidate_id", { length: 256 })
      .notNull()
      .references(() => candidateActions.candidateId, {
        onDelete: "restrict",
      }),
    planGeneration: integer("plan_generation").notNull().default(1),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    unique("action_plans_candidate_plan_generation_unique").on(
      table.candidateId,
      table.planGeneration,
    ),
    check(
      "action_plans_plan_generation_positive",
      sql`${table.planGeneration} >= 1`,
    ),
  ],
);

export const actionPlanSteps = pgTable(
  "action_plan_steps",
  {
    planId: varchar("plan_id", { length: 256 })
      .notNull()
      .references(() => actionPlans.planId, { onDelete: "cascade" }),
    stepId: varchar("step_id", { length: 256 }).notNull(),
    ordinal: integer("ordinal").notNull(),
    description: text("description").notNull(),
  },
  (table) => [
    primaryKey({
      name: "action_plan_steps_pk",
      columns: [table.planId, table.stepId],
    }),
    unique("action_plan_steps_plan_ordinal_unique").on(
      table.planId,
      table.ordinal,
    ),
    check("action_plan_steps_ordinal_non_negative", sql`${table.ordinal} >= 0`),
  ],
);

export const actionPlanStepDependencies = pgTable(
  "action_plan_step_dependencies",
  {
    planId: varchar("plan_id", { length: 256 }).notNull(),
    stepId: varchar("step_id", { length: 256 }).notNull(),
    dependsOnStepId: varchar("depends_on_step_id", { length: 256 }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "action_plan_step_dependencies_pk",
      columns: [table.planId, table.stepId, table.dependsOnStepId],
    }),
    foreignKey({
      name: "action_plan_step_dependencies_step_fk",
      columns: [table.planId, table.stepId],
      foreignColumns: [actionPlanSteps.planId, actionPlanSteps.stepId],
    }).onDelete("cascade"),
    foreignKey({
      name: "action_plan_step_dependencies_depends_on_step_fk",
      columns: [table.planId, table.dependsOnStepId],
      foreignColumns: [actionPlanSteps.planId, actionPlanSteps.stepId],
    }).onDelete("cascade"),
    check(
      "action_plan_step_dependencies_no_self_dependency",
      sql`${table.stepId} <> ${table.dependsOnStepId}`,
    ),
  ],
);
