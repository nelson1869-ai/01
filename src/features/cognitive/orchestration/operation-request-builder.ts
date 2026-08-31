import { createCanonicalFingerprint } from "../persistence/postgres/utils/canonical-fingerprint";
import type { PersistedCandidateAction } from "../persistence/contracts/persisted-candidate-action";
import type { PersistedActionPlan } from "../persistence/contracts/persisted-action-plan";
import type { PlanStepProposal } from "./cognitive-ports";
import type { AssembledCognitiveContext } from "./context-assembler";
import { ALLOWED_GITHUB_REPO, type GitHubOperationRequest } from "../adapters/github/github-adapter";

export interface BuiltOperationRequest<TRequest extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> {
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
    void context;

    const operationKind = candidate.action;
    const providerScope = "github-rest";

    let request: GitHubOperationRequest;

    switch (operationKind) {
      case "github.repo.get":
        request = {
          repository: ALLOWED_GITHUB_REPO,
        };
        break;

      case "github.contents.read": {
        // Extract requested path from candidate goal or perception if present, default to README.md
        let targetPath = "README.md";
        const goalLower = candidate.goal.toLowerCase();
        if (goalLower.includes("package.json")) {
          targetPath = "package.json";
        } else if (goalLower.includes("license")) {
          targetPath = "LICENSE";
        } else if (goalLower.includes("tsconfig.json")) {
          targetPath = "tsconfig.json";
        }
        request = {
          repository: ALLOWED_GITHUB_REPO,
          path: targetPath,
          ref: "main",
        };
        break;
      }

      case "github.issues.list":
        request = {
          repository: ALLOWED_GITHUB_REPO,
          state: "open",
          perPage: 10,
        };
        break;

      case "github.issue.get":
        request = {
          repository: ALLOWED_GITHUB_REPO,
          issueNumber: 1,
        };
        break;

      case "github.pull_requests.list":
        request = {
          repository: ALLOWED_GITHUB_REPO,
          state: "open",
          perPage: 10,
        };
        break;

      case "github.pull_request.get":
        request = {
          repository: ALLOWED_GITHUB_REPO,
          pullNumber: 1,
        };
        break;

      default:
        // Generic fallback for custom/test skills
        request = {
          repository: ALLOWED_GITHUB_REPO,
        };
        break;
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
