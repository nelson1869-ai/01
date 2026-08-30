export type PolicyOutcome = "ALLOW" | "REQUIRE_APPROVAL" | "DENY";

export type PolicyDecision = Readonly<{
  candidateId: string;
  outcome: PolicyOutcome;
  reason: string;
  policyIds: readonly string[];
}>;
