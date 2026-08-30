export interface CandidateAction {
  readonly id: string;
  readonly toolName: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly confidenceScore: number;
  readonly isGrounded: boolean;
  readonly rationale: string;
}
