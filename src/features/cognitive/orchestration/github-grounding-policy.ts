import type { PersistedCandidateAction } from "../persistence/contracts/persisted-candidate-action";
import type { PersistedGroundingResult } from "../persistence/contracts/persisted-grounding-result";
import { ALLOWED_GITHUB_REPO } from "../adapters/github/github-adapter";
import type {
  GroundingEvaluation,
  GroundingEvaluatorPort,
  PolicyEvaluation,
  PolicyEvaluatorPort,
} from "./cognitive-ports";
import type { AssembledCognitiveContext } from "./context-assembler";
import { SUPPORTED_M7_ACTIONS } from "./gemini-candidate-generator";

export class GitHubGroundingEvaluator implements GroundingEvaluatorPort {
  readonly evaluatorVersion = "github-grounding-v1";

  async evaluateGrounding(
    candidate: PersistedCandidateAction,
    context: AssembledCognitiveContext,
  ): Promise<GroundingEvaluation> {
    void context;

    // Check if action is in supported GitHub read-only allowlist
    const isSupportedAction = (
      SUPPORTED_M7_ACTIONS as readonly string[]
    ).includes(candidate.action);

    if (!isSupportedAction) {
      return {
        status: "CONFLICTING_EVIDENCE",
        confidence: 0.0,
        reason: `Candidate action "${candidate.action}" is not an approved read-only GitHub operation.`,
        evaluatorVersion: this.evaluatorVersion,
        evidenceIds: [],
      };
    }

    // Check for write action attempts disguised in goal or action
    const goalLower = candidate.goal.toLowerCase();
    if (
      goalLower.includes("write") ||
      goalLower.includes("delete") ||
      goalLower.includes("create") ||
      goalLower.includes("push") ||
      goalLower.includes("commit") ||
      candidate.action.includes("write") ||
      candidate.action.includes("delete") ||
      candidate.action.includes("create")
    ) {
      return {
        status: "CONFLICTING_EVIDENCE",
        confidence: 0.0,
        reason: `Mutating or write action detected in candidate goal or action: "${candidate.goal}".`,
        evaluatorVersion: this.evaluatorVersion,
        evidenceIds: [],
      };
    }

    return {
      status: "VERIFIED",
      confidence: 1.0,
      reason: `Action "${candidate.action}" verified against read-only GitHub target "${ALLOWED_GITHUB_REPO}".`,
      evaluatorVersion: this.evaluatorVersion,
      evidenceIds: candidate.evidenceIds ?? [],
    };
  }
}

export class GitHubPolicyEvaluator implements PolicyEvaluatorPort {
  readonly policyEngineVersion = "v1";
  readonly policyId = "github-readonly-v1";

  async evaluatePolicy(
    candidate: PersistedCandidateAction,
    grounding: PersistedGroundingResult,
    context: AssembledCognitiveContext,
  ): Promise<PolicyEvaluation> {
    void context;

    // Reject if grounding is not VERIFIED
    if (grounding.status !== "VERIFIED") {
      return {
        outcome: "DENY",
        reason: `Grounding status is "${grounding.status}"; execution denied.`,
        policyEngineVersion: this.policyEngineVersion,
        policyIds: [this.policyId],
      };
    }

    // Verify action is supported read-only GitHub action
    const isSupported = (SUPPORTED_M7_ACTIONS as readonly string[]).includes(
      candidate.action,
    );
    if (!isSupported) {
      return {
        outcome: "DENY",
        reason: `Action "${candidate.action}" violates security policy "${this.policyId}" (unsupported action).`,
        policyEngineVersion: this.policyEngineVersion,
        policyIds: [this.policyId],
      };
    }

    return {
      outcome: "ALLOW",
      reason: `Read-only GitHub action "${candidate.action}" permitted under policy "${this.policyId}".`,
      policyEngineVersion: this.policyEngineVersion,
      policyIds: [this.policyId],
    };
  }
}
