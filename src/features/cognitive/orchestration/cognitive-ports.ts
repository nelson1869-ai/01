import type { z } from "zod";

import type { MemoryKind } from "../domain/memory";
import type { PersistedCandidateAction } from "../persistence/contracts/persisted-candidate-action";
import type { PersistedExecution } from "../persistence/contracts/execution";
import type { PersistedGroundingResult } from "../persistence/contracts/persisted-grounding-result";
import type { PersistedObservation } from "../persistence/contracts/persisted-observation";
import type { jsonObjectSchema } from "../persistence/contracts/primitives";
import type { PersistedResultVerification } from "../persistence/contracts/result-verification";
import type { PersistedCueIngress } from "../persistence/contracts/cue-ingress";
import type {
  AssembledCognitiveContext,
  PerceptionResult,
} from "./context-assembler";

export interface PerceptionPort {
  perceive(cue: PersistedCueIngress): Promise<PerceptionResult>;
}

export interface GeneratedCandidateAction {
  readonly candidateId: string;
  readonly cueId: string;
  readonly goal: string;
  readonly action: string;
  readonly confidence: number;
  readonly expectedUtility: number;
  readonly estimatedRisk: number;
  readonly estimatedCost: number;
  readonly evidenceIds?: readonly string[];
}

export interface CandidateGeneratorPort {
  generateCandidates(
    context: AssembledCognitiveContext,
  ): Promise<readonly GeneratedCandidateAction[]>;
}

export interface GroundingEvaluation {
  readonly status:
    | "VERIFIED"
    | "INSUFFICIENT_EVIDENCE"
    | "CONFLICTING_EVIDENCE";
  readonly confidence: number;
  readonly reason: string;
  readonly evaluatorVersion: string;
  readonly evidenceIds: readonly string[];
}

export interface GroundingEvaluatorPort {
  evaluateGrounding(
    candidate: PersistedCandidateAction,
    context: AssembledCognitiveContext,
  ): Promise<GroundingEvaluation>;
}

export interface PolicyEvaluation {
  readonly outcome: "ALLOW" | "REQUIRE_APPROVAL" | "DENY";
  readonly reason: string;
  readonly policyEngineVersion: string;
  readonly policyIds: readonly string[];
}

export interface PolicyEvaluatorPort {
  evaluatePolicy(
    candidate: PersistedCandidateAction,
    grounding: PersistedGroundingResult,
    context: AssembledCognitiveContext,
  ): Promise<PolicyEvaluation>;
}

export interface PlanStepProposal {
  readonly stepId: string;
  readonly ordinal: number;
  readonly description: string;
}

export interface PlanStepDependencyProposal {
  readonly stepId: string;
  readonly dependsOnStepId: string;
}

export interface PlanProposal {
  readonly planId: string;
  readonly planGeneration: number;
  readonly steps: readonly PlanStepProposal[];
  readonly dependencies?: readonly PlanStepDependencyProposal[];
}

export interface PlanBuilderPort {
  buildPlan(
    candidate: PersistedCandidateAction,
    context: AssembledCognitiveContext,
  ): Promise<PlanProposal>;
}

export interface MemoryProposal {
  readonly memoryId: string;
  readonly kind: MemoryKind;
  readonly key: string;
  readonly version: number;
  readonly content: z.infer<typeof jsonObjectSchema>;
  readonly sourceIds: readonly string[];
  readonly confidence: number;
  readonly admissionRuleVersion: string;
}

export interface MemoryProposalStrategyPort {
  proposeVerifiedMemory(
    execution: PersistedExecution,
    verification: PersistedResultVerification,
    observations: readonly PersistedObservation[],
  ): Promise<readonly MemoryProposal[]>;
}
