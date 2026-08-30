export type PlanStep = Readonly<{
  id: string;
  description: string;
  dependsOn: readonly string[];
}>;

export type ActionPlan = Readonly<{
  id: string;
  candidateId: string;
  steps: readonly PlanStep[];
  createdAt: string;
}>;
