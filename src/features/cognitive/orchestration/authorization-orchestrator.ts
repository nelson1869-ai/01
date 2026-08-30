import type { AllowedExecutionSafetyState } from "../domain/execution-safety";
import type { AuthorizationIssuanceCommand } from "../persistence/contracts/authorization-issuance-command";
import type { PersistedCognitiveSession } from "../persistence/contracts/cognitive-session";
import type { StoredExecutionSafety } from "../persistence/contracts/execution-safety";
import type { PersistedGroundingResult } from "../persistence/contracts/persisted-grounding-result";
import type { PersistedPolicyDecision } from "../persistence/contracts/persisted-policy-decision";
import { PersistenceError } from "../persistence/postgres/errors/persistence-errors";
import { groundingRepository } from "../persistence/postgres/repositories/grounding-repository";
import { policyRepository } from "../persistence/postgres/repositories/policy-repository";
import { persistAuthorizationIssuance } from "../persistence/postgres/transactions/persist-authorization-issuance";
import type { DatabaseClient } from "../persistence/postgres/transactions/transaction-executor";
import {
  mapPersistedGroundingStatusToDomain,
  mapPersistedPolicyOutcomeToDomain,
} from "../persistence/postgres/utils/enum-mappers";

export type GateInspectionResult =
  | {
      readonly status: "READY_TO_AUTHORIZE";
      readonly candidateId: string;
      readonly groundingResultId: string;
      readonly policyDecisionId: string;
    }
  | {
      readonly status: "GROUNDING_NOT_VERIFIED";
      readonly candidateId: string;
      readonly groundingStatus: string;
      readonly reason: string;
    }
  | {
      readonly status: "POLICY_REQUIRES_APPROVAL";
      readonly candidateId: string;
      readonly policyOutcome: string;
      readonly reason: string;
    }
  | {
      readonly status: "POLICY_DENIED";
      readonly candidateId: string;
      readonly policyOutcome: string;
      readonly reason: string;
    }
  | {
      readonly status: "BINDING_MISMATCH";
      readonly candidateId: string;
      readonly reason: string;
    };

export type AuthorizationOrchestrationResult =
  | {
      readonly status: "AUTHORIZED";
      readonly sessionId: string;
      readonly candidateId: string;
      readonly generation: number;
      readonly authorization: AllowedExecutionSafetyState;
      readonly session: PersistedCognitiveSession;
      readonly safetyState: StoredExecutionSafety;
      readonly isReplay: false;
    }
  | {
      readonly status: "ALREADY_ISSUED_NO_CAPABILITY";
      readonly sessionId: string;
      readonly candidateId: string;
      readonly generation: number;
      readonly authorization: null;
      readonly session: PersistedCognitiveSession;
      readonly safetyState: StoredExecutionSafety;
      readonly isReplay: true;
    }
  | {
      readonly status: "GROUNDING_NOT_VERIFIED";
      readonly sessionId: string;
      readonly candidateId: string;
      readonly groundingStatus: string;
      readonly reason: string;
    }
  | {
      readonly status: "POLICY_REQUIRES_APPROVAL";
      readonly sessionId: string;
      readonly candidateId: string;
      readonly policyOutcome: string;
      readonly reason: string;
    }
  | {
      readonly status: "POLICY_DENIED";
      readonly sessionId: string;
      readonly candidateId: string;
      readonly policyOutcome: string;
      readonly reason: string;
    };

export function inspectAuthorizationGate(params: {
  readonly candidateId: string;
  readonly grounding: PersistedGroundingResult;
  readonly policy: PersistedPolicyDecision;
}): GateInspectionResult {
  if (
    params.grounding.candidateId !== params.candidateId ||
    params.policy.candidateId !== params.candidateId ||
    params.policy.groundingResultId !== params.grounding.groundingResultId
  ) {
    return {
      status: "BINDING_MISMATCH",
      candidateId: params.candidateId,
      reason:
        "Grounding or policy decision does not match the target candidate or grounding binding.",
    };
  }

  const domainGrounding = mapPersistedGroundingStatusToDomain(
    params.grounding.status,
  );
  if (domainGrounding !== "VERIFIED") {
    return {
      status: "GROUNDING_NOT_VERIFIED",
      candidateId: params.candidateId,
      groundingStatus: params.grounding.status,
      reason: `Grounding status is "${params.grounding.status}" (must be VERIFIED).`,
    };
  }

  const domainPolicy = mapPersistedPolicyOutcomeToDomain(params.policy.outcome);
  if (domainPolicy === "REQUIRE_APPROVAL") {
    return {
      status: "POLICY_REQUIRES_APPROVAL",
      candidateId: params.candidateId,
      policyOutcome: params.policy.outcome,
      reason:
        "Policy requires human approval before autonomous execution can be authorized.",
    };
  }

  if (domainPolicy === "DENY") {
    return {
      status: "POLICY_DENIED",
      candidateId: params.candidateId,
      policyOutcome: params.policy.outcome,
      reason: "Policy denied autonomous execution.",
    };
  }

  return {
    status: "READY_TO_AUTHORIZE",
    candidateId: params.candidateId,
    groundingResultId: params.grounding.groundingResultId,
    policyDecisionId: params.policy.policyDecisionId,
  };
}

export async function orchestrateAuthorizationIssuance(
  db: DatabaseClient,
  command: AuthorizationIssuanceCommand,
): Promise<AuthorizationOrchestrationResult> {
  const grounding = await groundingRepository.findGroundingResultById(
    db,
    command.groundingResultId,
  );

  if (!grounding) {
    throw PersistenceError.notFound(
      `Grounding result "${command.groundingResultId}" not found.`,
      { groundingResultId: command.groundingResultId },
    );
  }

  const policy = await policyRepository.findPolicyDecisionById(
    db,
    command.policyDecisionId,
  );

  if (!policy) {
    throw PersistenceError.notFound(
      `Policy decision "${command.policyDecisionId}" not found.`,
      { policyDecisionId: command.policyDecisionId },
    );
  }

  const gate = inspectAuthorizationGate({
    candidateId: command.candidateId,
    grounding,
    policy,
  });

  if (gate.status === "GROUNDING_NOT_VERIFIED") {
    return {
      status: "GROUNDING_NOT_VERIFIED",
      sessionId: command.sessionId,
      candidateId: command.candidateId,
      groundingStatus: gate.groundingStatus,
      reason: gate.reason,
    };
  }

  if (gate.status === "POLICY_REQUIRES_APPROVAL") {
    return {
      status: "POLICY_REQUIRES_APPROVAL",
      sessionId: command.sessionId,
      candidateId: command.candidateId,
      policyOutcome: gate.policyOutcome,
      reason: gate.reason,
    };
  }

  if (gate.status === "POLICY_DENIED") {
    return {
      status: "POLICY_DENIED",
      sessionId: command.sessionId,
      candidateId: command.candidateId,
      policyOutcome: gate.policyOutcome,
      reason: gate.reason,
    };
  }

  if (gate.status === "BINDING_MISMATCH") {
    throw PersistenceError.stateConflict(gate.reason, {
      candidateId: command.candidateId,
    });
  }

  return await persistAuthorizationIssuance(db, command);
}
