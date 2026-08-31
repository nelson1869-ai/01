import { createCanonicalFingerprint } from "../persistence/postgres/utils/canonical-fingerprint";
import type { PersistedCandidateAction } from "../persistence/contracts/persisted-candidate-action";
import type { PersistedActionPlan } from "../persistence/contracts/persisted-action-plan";
import type { PlanStepProposal } from "./cognitive-ports";
import type { AssembledCognitiveContext } from "./context-assembler";
import {
  ALLOWED_GITHUB_REPO,
  type GitHubOperationRequest,
} from "../adapters/github/github-adapter";

export interface BuiltOperationRequest<
  TRequest extends Readonly<Record<string, unknown>> = Readonly<
    Record<string, unknown>
  >,
> {
  readonly operationKind: string;
  readonly providerScope: string;
  readonly request: TRequest;
  readonly requestFingerprint: string;
  readonly providerIdempotencyKey: string | null;
}

export interface OperationRequestBuilderPort {
  buildOperationRequest(
    candidate: PersistedCandidateAction,
    plan: PersistedActionPlan,
    step: PlanStepProposal,
    context?: AssembledCognitiveContext,
  ): BuiltOperationRequest;
}

export class DefaultOperationRequestBuilder implements OperationRequestBuilderPort {
  buildOperationRequest(
    candidate: PersistedCandidateAction,
    plan: PersistedActionPlan,
    step: PlanStepProposal,
    context?: AssembledCognitiveContext,
  ): BuiltOperationRequest {
    void plan;
    void step;

    const operationKind = candidate.action;
    const providerScope = "github-rest";

    let request: GitHubOperationRequest;

    if (context?.targetSpec) {
      const target = context.targetSpec;
      switch (operationKind) {
        case "github.repo.get":
          request = {
            repository: target.repository || ALLOWED_GITHUB_REPO,
          };
          break;

        case "github.contents.read":
          if (target.kind !== "FILE") {
            throw new Error(
              `Target mismatch: operation "${operationKind}" requires FILE target spec, found "${target.kind}".`,
            );
          }
          request = {
            repository: target.repository || ALLOWED_GITHUB_REPO,
            path: target.path,
            ref: target.ref ?? "main",
          };
          break;

        case "github.issues.list":
          request = {
            repository: target.repository || ALLOWED_GITHUB_REPO,
            state:
              (target.kind === "ISSUE_LIST" ? target.state : "open") ?? "open",
            perPage: (target.kind === "ISSUE_LIST" ? target.perPage : 10) ?? 10,
          };
          break;

        case "github.issue.get":
          if (target.kind !== "ISSUE") {
            throw new Error(
              `Target mismatch: operation "${operationKind}" requires ISSUE target spec, found "${target.kind}".`,
            );
          }
          request = {
            repository: target.repository || ALLOWED_GITHUB_REPO,
            issueNumber: target.issueNumber,
          };
          break;

        case "github.pull_requests.list":
          request = {
            repository: target.repository || ALLOWED_GITHUB_REPO,
            state:
              (target.kind === "PULL_REQUEST_LIST" ? target.state : "open") ??
              "open",
            perPage:
              (target.kind === "PULL_REQUEST_LIST" ? target.perPage : 10) ?? 10,
          };
          break;

        case "github.pull_request.get":
          if (target.kind !== "PULL_REQUEST") {
            throw new Error(
              `Target mismatch: operation "${operationKind}" requires PULL_REQUEST target spec, found "${target.kind}".`,
            );
          }
          request = {
            repository: target.repository || ALLOWED_GITHUB_REPO,
            pullNumber: target.pullNumber,
          };
          break;

        default:
          request = {
            repository: target.repository || ALLOWED_GITHUB_REPO,
          };
          break;
      }
    } else {
      switch (operationKind) {
        case "github.repo.get":
          request = { repository: ALLOWED_GITHUB_REPO };
          break;

        case "github.issues.list":
          request = {
            repository: ALLOWED_GITHUB_REPO,
            state: "open",
            perPage: 10,
          };
          break;

        case "github.pull_requests.list":
          request = {
            repository: ALLOWED_GITHUB_REPO,
            state: "open",
            perPage: 10,
          };
          break;

        default:
          throw new Error(
            `Cannot build operation request for "${operationKind}" without authoritative context targetSpec.`,
          );
      }
    }

    const requestFingerprint = createCanonicalFingerprint({
      operationKind,
      providerScope,
      request,
    });

    return {
      operationKind,
      providerScope,
      request,
      requestFingerprint,
      providerIdempotencyKey: null,
    };
  }
}
