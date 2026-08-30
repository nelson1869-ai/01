# Durable Persistence V1

Status: implementation-ready architecture; no database implementation yet.

## 1. Goals

Durable Persistence V1 defines what AutoDo AI retains across process, worker,
server, and deployment failure. It must support at-least-once delivery,
idempotent processing, optimistic concurrency, durable reconciliation, and
effectively-once logical side effects without claiming universal distributed
exactly-once execution.

The boundary must:

- preserve authoritative current cognitive, execution, cooldown, and safety state;
- preserve immutable evidence, decisions, audits, execution history, rewards,
  and verified memory;
- prevent duplicate cues, logical operations, audits, verifications, and rewards;
- reject stale workers with atomic conditional updates;
- keep speculative working state and chain-of-thought out of durable storage;
- never turn deserialized data into trusted autonomous permission.

This design does not select a PostgreSQL client, migration tool, or ORM.

## 2. Persistence categories

1. **Durable current state** — authoritative mutable rows used to resume work:
   session phase/counters/cooldown, execution and step status, logical operation
   outcome, safety generation, learning aggregates, and memory heads.
2. **Append-only history / ledger** — immutable cues, decisions, plans,
   observations, verification versions, failure audits, safety/execution events,
   operation attempts, and rewards. Corrections append new events.
3. **Verified long-term memory** — immutable, versioned memory entries admitted
   only through a verified boundary, plus a mutable pointer to the current entry.
4. **Ephemeral working state** — assumptions, retrieved scratch context,
   intermediate hypotheses, and unevaluated tool output. It is cleared and is not
   a session document in PostgreSQL.
5. **Runtime-only authorization** — the private brand and trusted `ALLOWED`
   authorization object. These are never serialized or reconstructed from JSON.

## 3. Complete domain classification table

| Domain object | Persistence category | Mutable? | Append-only? | Important IDs | Idempotency requirement | Concurrency requirement | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `AgentContext` | Durable current state, excluding `workingMemory` | Yes | No | `sessionId`, current `cueId` | A retried transition reuses one command key | `row_version` conditional update; phase/counters/cooldown change atomically | Persist explicit columns, not the whole object as JSON. Retain while session and audit retention require it. |
| `Cue` | Append-only ingress record | No, except controlled payload redaction/expiry | Yes | `cueId`, new `externalEventId`, `source` | Unique `(source, external_event_id)` | Concurrent insert must use a database unique constraint | `payload` may be JSONB and shorter-lived than cue identity/metadata. |
| `CandidateAction` | Immutable decision artifact | No | Yes | `candidateId`, `cueId`, `sessionId` | Stable candidate ID or generation key per logical generation | Insert-once; no overwrite by parallel generators | Goal/action and numeric estimates are columns; evidence is a join. Do not store hidden reasoning. |
| `CandidateScore` | Immutable snapshot on candidate row | No | Yes with candidate | Needs `candidateId`, score formula/version, timestamp | Same candidate scoring command must not duplicate/overwrite | Candidate insert or evaluation version uniqueness | Current type lacks ID, timestamp, and formula version. No separate table is needed for one V1 score per candidate. |
| `Evidence` | Immutable evidence registry | No | Yes | `evidenceId`, `source`, `sourceId` | Stable evidence ID/source identity | Insert-once | Claims and timestamps are relational; small provider metadata may be JSONB. |
| `GroundingResult` | Append-only decision history | No | Yes | New `groundingResultId`, `candidateId`, evaluation key | Stable evaluation ID/idempotency key | Unique logical evaluation; never update a prior result | Evidence references use a join. Current type lacks result ID and evaluation timestamp. |
| `PolicyDecision` | Append-only decision history | No | Yes | New `policyDecisionId`, `candidateId`, `groundingResultId` | Stable evaluation ID/idempotency key | Unique logical evaluation | Policy IDs use a join. Stored `ALLOW` is audit data, never runtime permission. |
| `ActionPlan` | Immutable plan | No | Yes | `planId`, `candidateId` | Stable plan ID or `(candidate, plan_generation)` | Insert-once | A changed plan is a new plan generation, not an update. |
| `PlanStep` | Immutable plan child | No | Yes with plan | `(planId, stepId)` | Stable step ID inside the plan | Insert with plan transaction | Dependencies use a relational join, not JSONB. |
| `ExecutionRecord` | Durable current state plus execution-event history | Yes | Current row: no; events: yes | `executionId`, `sessionId`, `planId`, `currentStepId` | Stable execution ID; create once | Status and `row_version` conditional updates; safety generation checked at start | Current type lacks `sessionId`, row version, update time, and generation-at-start. Long-lived. |
| `ExecutionSafetyState` | Durable current generation/status plus append-only transition history | Yes | Current row: no; events: yes | `sessionId`, `generation` | Transition command key and unique target generation | Atomic compare-and-swap on expected generation | PostgreSQL stores only fail-closed `UNAUTHORIZED`/`BLOCKED`, never trusted runtime `ALLOWED`. |
| Runtime allowed authorization | Runtime-only authorization | Frozen runtime capability | No | Candidate ID and safety generation in private brand | A fresh issuance is one logical transition | Must match authoritative current generation at execution boundary | Never serialize, cache durably, or accept from JSON. |
| `Observation` | Append-only history | No | Yes | `observationId`, `executionId`, optional `stepId`, new source event ID | Stable observation ID or unique source-event key | Concurrent duplicate observations conflict safely | Structured `data` may be JSONB and can have shorter retention. |
| `ResultVerification` | Append-only versioned history | No | Yes | `verificationId`, `executionId`, new verification generation/input digest | Same canonical observation set and verifier version deduplicates | Unique execution/version and observation-set digest | A new observation set or verifier version creates a new immutable verification. |
| `RewardEvent` | Append-only reward ledger | No | Yes | `rewardEventId`, `executionId`, `verificationId`, new reward rule/key | Unique `(verification_id, reward_rule_id)` plus stable event key | Insert and aggregate update in one transaction | Reward events remain the source of truth. Long-lived. |
| `LearningState` | Derived durable current state | Yes | No | `skillKey` | Only update when a new reward row is inserted | `row_version` or atomic increment in reward transaction | Rebuildable from reward ledger; never replace the ledger. |
| `VerifiedMemory` | Verified long-term memory, immutable versions | Entry: no; head pointer: yes | Entries: yes | `memoryId`, `(kind, key, version)`, evidence source IDs | Stable admission command and version uniqueness | Head update uses expected version | `content` may be JSONB. Only verified evidence/results can admit a version. Long-lived. |
| `FailureAuditEvent` | Append-only audit ledger | No | Yes | `auditEventId`, `sessionId`, new logical failure key and revoked generation | Unique logical failure key; stable event ID | Insert in the same transaction as revocation/recovery | Must gain optional candidate/plan/execution/step correlation and revoked generation. Long-lived. |
| `FailureRecoveryDecision` | Stored as part of failure audit outcome | No | Yes with audit | `auditEventId` | Same failure command produces one audit/recovery outcome | Same failure transaction | Store action and reason summary, not speculative reasoning. |
| `workingMemory` / `clearWorkingMemory` | Ephemeral working state | Yes in memory | No | Session-local only | Not applicable | Must never be treated as authoritative persisted state | Persist only explicit resumable pointers already modeled relationally, such as cue/execution IDs. |

## 4. Proposed PostgreSQL tables

The smallest coherent V1 schema uses relational identity and association tables;
it does not use a generic cognitive-session JSON document.

| Table | Purpose |
| --- | --- |
| `cues` | Immutable, deduplicated ingress events. |
| `cognitive_sessions` | Current phase, retry/failure counters, cooldown, and row version. |
| `evidence_records` | Reusable durable evidence identity and claim metadata. |
| `candidate_actions` | Immutable candidate and score snapshot. |
| `candidate_evidence` | Candidate-to-evidence references. |
| `grounding_results` | Immutable grounding evaluations. |
| `grounding_result_evidence` | Grounding-to-evidence references. |
| `policy_decisions` | Immutable policy outcomes tied to grounding/candidate. |
| `policy_decision_policy_refs` | Applied policy IDs. No policy-definition table is needed yet. |
| `action_plans` | Immutable candidate-bound plans. |
| `action_plan_steps` | Plan-scoped immutable steps. |
| `action_plan_step_dependencies` | Relational dependency edges between steps in one plan. |
| `executions` | Mutable authoritative execution record. |
| `execution_step_state` | Mutable per-execution state for each plan step. |
| `execution_operations` | Mutable logical real-world operation and reconciliation outcome. |
| `execution_operation_attempts` | Immutable record of each attempt of one logical operation. |
| `execution_events` | Immutable execution status transition history. |
| `execution_safety_state` | One current, fail-closed safety generation per session. |
| `execution_safety_events` | Immutable generation transition/revocation history. |
| `observations` | Immutable observations from tools/providers/humans. |
| `result_verifications` | Immutable, versioned verification results. |
| `result_verification_observations` | Exact observation set used by a verification. |
| `failure_audit_events` | Immutable failure/recovery audit facts with execution correlation. |
| `failure_audit_evidence` | Failure-to-evidence references. |
| `reward_events` | Immutable reward ledger. |
| `learning_state` | Mutable derived aggregate by skill key. |
| `verified_memory` | Immutable verified memory versions. |
| `verified_memory_sources` | Memory-to-evidence references. |
| `verified_memory_heads` | Mutable current version pointer per memory key. |
| `idempotency_records` | Request/command replay record where a domain table alone is insufficient. |

`candidate_scores` is deliberately not separate in V1: the current domain has
one score snapshot per candidate. `AgentContext.workingMemory` and runtime
authorization deliberately have no tables.

### Core column sketch

Names are illustrative migration targets; timestamps are `timestamptz`, counts
and versions are `bigint` or `integer` as appropriate, and every mandatory
column is `NOT NULL`.

- `cues`: `cue_id uuid`, `source text`, `external_event_id text`, `cue_type
  text`, `occurred_at`, `received_at`, `payload jsonb`, nullable
  `payload_expires_at`, and optional redacted `payload_hash text`.
- `cognitive_sessions`: `session_id uuid`, `cue_id uuid`, `phase text`,
  `failure_count`, `retry_count`, `max_retries`, nullable `cooldown_until`,
  nullable current `candidate_id`, `plan_id`, and `execution_id`, `row_version`,
  `created_at`, and `updated_at`. There is no general working-memory column.
- `evidence_records`: `evidence_id uuid`, `source text`, `source_id text`,
  `claim text`, `observed_at`, `created_at`, and optional bounded
  `provider_metadata jsonb`.
- `candidate_actions`: `candidate_id uuid`, `session_id uuid`, `cue_id uuid`,
  `goal text`, `action text`, `confidence numeric`, `expected_utility numeric`,
  `estimated_risk numeric`, `estimated_cost numeric`, `score_value numeric`,
  `recommendation text`, `score_formula_version text`, and `created_at`.
- `candidate_evidence`: `candidate_id uuid`, `evidence_id uuid`, and optional
  `ordinal integer`.
- `grounding_results`: `grounding_result_id uuid`, `candidate_id uuid`,
  `evaluation_key text`, `status text`, `confidence numeric`, `reason text`,
  `evaluator_version text`, and `evaluated_at`.
- `grounding_result_evidence`: `grounding_result_id uuid`, `evidence_id uuid`,
  and optional `ordinal integer`.
- `policy_decisions`: `policy_decision_id uuid`, `candidate_id uuid`,
  `grounding_result_id uuid`, `evaluation_key text`, `outcome text`, `reason
  text`, `policy_engine_version text`, and `evaluated_at`.
- `policy_decision_policy_refs`: `policy_decision_id uuid`, `policy_id text`.
- `action_plans`: `plan_id uuid`, `candidate_id uuid`, `plan_generation
  integer`, `created_at`.
- `action_plan_steps`: `plan_id uuid`, `step_id uuid`, `ordinal integer`, and
  `description text`.
- `action_plan_step_dependencies`: `plan_id uuid`, `step_id uuid`, and
  `depends_on_step_id uuid`.
- `executions`: `execution_id uuid`, `session_id uuid`, `plan_id uuid`, `status
  text`, nullable `current_step_id uuid`, nullable `started_at`, nullable
  `completed_at`, nullable `error text`, nullable `safety_generation_at_start
  bigint`, `row_version`, `created_at`, and `updated_at`.
- `execution_step_state`: `execution_id uuid`, `plan_id uuid`, `step_id uuid`,
  `status text`, `operation_generation integer`, `row_version`, nullable
  `started_at`, nullable `completed_at`, nullable `error text`, and `updated_at`.
- `execution_operations`: `operation_id uuid`, `execution_id uuid`, `step_id
  uuid`, `operation_generation integer`, `operation_kind text`,
  `operation_idempotency_key text`, `request_fingerprint text`, `status text`,
  `attempt_count integer`, nullable `provider_scope text`, nullable
  `provider_idempotency_key text`, nullable `provider_operation_id text`,
  nullable `uncertainty_reason text`, optional bounded `result_metadata jsonb`,
  `row_version`, `created_at`, and `updated_at`.
- `execution_operation_attempts`: `attempt_id uuid`, `operation_id uuid`,
  `attempt_number integer`, `status text`, nullable `worker_id text`,
  `started_at`, nullable `finished_at`, nullable `error_summary text`, and
  optional bounded `provider_metadata jsonb`.
- `execution_events`: `execution_event_id uuid`, `execution_id uuid`,
  `transition_sequence bigint`, nullable `from_status text`, `to_status text`,
  nullable `step_id uuid`, nullable `safety_generation bigint`, nullable
  `operation_id uuid`, `event_key text`, `reason text`, and `occurred_at`.
- `execution_safety_state`: `session_id uuid`, `generation bigint`,
  `durable_status text`, nullable `failure_code text`, nullable `reason text`,
  nullable `blocked_at`, nullable `evaluated_candidate_id uuid`, nullable
  `grounding_result_id uuid`, nullable `policy_decision_id uuid`, and
  `updated_at`. `durable_status` cannot be `ALLOWED`.
- `execution_safety_events`: `safety_event_id uuid`, `session_id uuid`,
  `from_generation bigint`, `to_generation bigint`, `event_type text`, nullable
  `candidate_id uuid`, nullable `grounding_result_id uuid`, nullable
  `policy_decision_id uuid`, nullable `failure_audit_event_id uuid`, `event_key
  text`, `reason text`, and `occurred_at`.
- `observations`: `observation_id uuid`, `execution_id uuid`, nullable `step_id
  uuid`, `source text`, nullable `source_event_id text`, `summary text`, `data
  jsonb`, `observed_at`, and nullable `payload_expires_at`.
- `result_verifications`: `verification_id uuid`, `execution_id uuid`,
  `verification_generation integer`, `observation_set_digest text`,
  `verifier_version text`, `status text`, `confidence numeric`, `reason text`,
  and `verified_at`.
- `result_verification_observations`: `verification_id uuid`, `observation_id
  uuid`, and `ordinal integer` used in canonical digest construction.
- `failure_audit_events`: `audit_event_id uuid`, `logical_failure_key text`,
  `session_id uuid`, nullable `candidate_id uuid`, nullable `plan_id uuid`,
  nullable `execution_id uuid`, nullable `step_id uuid`, `failure_code text`,
  `original_phase text`, `failure_count`, `retry_count`, `from_safety_generation
  bigint`, `revoked_safety_generation bigint`, `recovery_action text`, `reason
  text`, and `created_at`.
- `failure_audit_evidence`: `audit_event_id uuid`, `evidence_id uuid`.
- `reward_events`: `reward_event_id uuid`, `reward_idempotency_key text`,
  `execution_id uuid`, `verification_id uuid`, `reward_rule_id text`, `signal
  text`, `value numeric`, `reason text`, and `created_at`.
- `learning_state`: `skill_key text`, `confidence numeric`, `total_reward
  numeric`, `sample_count bigint`, `row_version`, and `updated_at`.
- `verified_memory`: `memory_id uuid`, `kind text`, `memory_key text`,
  `memory_version integer`, `content jsonb`, `confidence numeric`,
  `admission_rule_version text`, nullable `supersedes_memory_id uuid`,
  `verified_at`, and `created_at`.
- `verified_memory_sources`: `memory_id uuid`, `evidence_id uuid`.
- `verified_memory_heads`: `kind text`, `memory_key text`, `memory_id uuid`,
  `memory_version integer`, `row_version`, and `updated_at`.
- `idempotency_records`: `scope text`, `idempotency_key text`, `request_hash
  text`, `status text`, nullable `result_resource_type text`, nullable
  `result_resource_id uuid`, nullable `error_code text`, `created_at`,
  `updated_at`, and nullable `expires_at`.

## 5. Primary keys

Use PostgreSQL `uuid` for internal durable IDs, supplied once by the command so
retries reuse the same ID. Existing TypeScript `string` IDs remain compatible at
the domain boundary. Use `text` only for external/provider IDs, policy IDs,
skill keys, and memory keys.

- Single UUID PKs: cue, session, evidence, candidate, grounding result, policy
  decision, plan, execution, operation, operation attempt, execution event,
  safety event, observation, verification, audit, reward, and memory entry IDs.
- Composite PKs: `action_plan_steps(plan_id, step_id)`,
  `execution_step_state(execution_id, step_id)`, plan dependencies,
  evidence/observation association tables, and policy-reference joins.
- Natural current-state PKs: `execution_safety_state(session_id)`,
  `learning_state(skill_key)`, and `verified_memory_heads(kind, memory_key)`.
- `idempotency_records(scope, idempotency_key)` is a composite PK.

## 6. Foreign keys

Required relationships include:

- `cognitive_sessions.cue_id -> cues.cue_id` with `UNIQUE(cue_id)` for one V1
  logical work session per deduplicated cue;
- candidate -> session and cue;
- candidate/evaluation/audit/memory evidence joins -> `evidence_records`;
- grounding -> candidate; policy decision -> candidate and grounding result;
- plan -> candidate; plan step -> plan; dependency source and target -> steps in
  the same plan;
- execution -> session and plan;
- execution current step and step-state rows -> `(plan_id, step_id)` through
  composite keys that prove the step belongs to the execution's plan;
- operation -> execution and execution step; attempt -> operation;
- safety current/history -> session, with nullable evaluation references only
  as non-authoritative evidence of the last runtime authorization evaluation;
- observation -> execution and optional execution step;
- verification -> execution; verification observation join -> verification and
  observations belonging to the same execution;
- failure audit -> session and nullable candidate/plan/execution/step;
- reward -> execution and verification using a composite FK
  `(verification_id, execution_id)` so they cannot disagree;
- verified-memory sources -> evidence records; memory head -> memory entry.

Use `RESTRICT` for long-lived audit/history parents. Routine deletion must not
cascade away audit, reward, execution, or verified-memory history. Payload
redaction is separate from deleting identity rows.

## 7. Unique constraints

Database uniqueness is the final race-safe duplicate barrier.

- `cues(source, external_event_id)`.
- `cognitive_sessions(cue_id)` for V1's one-work-item-per-cue rule.
- `candidate_actions(session_id, candidate_id)` and, if candidate IDs are not
  globally unique, make this the primary identity.
- `grounding_results(candidate_id, evaluation_key)` and
  `policy_decisions(candidate_id, evaluation_key)`.
- `action_plans(candidate_id, plan_generation)`.
- `execution_operations(execution_id, step_id, operation_generation)`.
- `execution_operations(operation_idempotency_key)`; keys are globally scoped
  opaque values derived from the logical operation, not from attempt number.
- `execution_operation_attempts(operation_id, attempt_number)`.
- `execution_events(execution_id, transition_sequence)` and unique event
  idempotency key.
- `execution_safety_events(session_id, to_generation)` and unique transition
  command key.
- observations by stable `observation_id`; additionally
  `(execution_id, source, source_event_id)` when a source event ID exists.
- `result_verifications(execution_id, verification_generation)` and
  `(execution_id, observation_set_digest, verifier_version)`.
- `failure_audit_events(session_id, logical_failure_key)` and
  `(session_id, revoked_safety_generation)` for the one revocation-causing
  failure transition represented by that generation.
- `reward_events(verification_id, reward_rule_id)` and a stable reward
  idempotency key.
- `verified_memory(kind, memory_key, memory_version)` and unique admission key.
- provider-specific idempotency keys may be unique within provider/account
  scope, never globally unless the provider guarantees global uniqueness.

## 8. CHECK constraints

Use database checks as safety barriers, with the same enum values as validated
application codecs.

- `failure_count >= 0`, `retry_count >= 0`, `max_retries >= 0`, and
  `retry_count <= max_retries`.
- `row_version >= 0`, `safety_generation >= 0`, operation/plan/verification
  generations and sequence numbers are non-negative.
- Confidence, utility, risk, cost, and score fields are finite numeric values in
  `[0,1]`; reward values are finite `numeric`, not floating-point NaN.
- Session cooldown invariant:
  `phase = 'COOLDOWN'` iff `cooldown_until IS NOT NULL`.
- Durable safety status is only `UNAUTHORIZED` or `BLOCKED`; there is no
  database `ALLOWED` value. `BLOCKED` requires failure code, reason, and
  `blocked_at`; `UNAUTHORIZED` forbids failure and `blocked_at`.
- Safety evaluation references are either all null or a complete candidate +
  grounding + policy set. They are evidence for re-evaluation, not permission.
- Execution timestamps/status combinations are coherent: `PENDING` has no
  start/completion, `RUNNING` has a start and no completion, terminal states
  have completion. `BLOCKED` requires an error/reason.
- An operation `SUCCEEDED` has a completion time; `UNKNOWN` requires an
  uncertainty reason; attempt numbers and operation generations are positive.
- Verification confidence is in `[0,1]`; verification generation is positive.
- Learning sample count is non-negative; memory confidence is in `[0,1]` and
  memory version is positive.
- Plan dependency source and target differ. Cycle prevention remains an
  application/domain validation because a simple row check cannot prove a DAG.

## 9. JSONB usage rules

JSONB is allowed for genuinely flexible boundary data:

- `cues.payload`;
- `observations.data`;
- `verified_memory.content`;
- limited provider request/response metadata and reconciliation details;
- optional redacted evidence/provider metadata.

JSONB must not hide session, cue, candidate, plan, execution, step,
verification, reward, audit, memory, operation, or safety-generation identity.
Statuses, counters, timestamps, candidate score inputs, policy IDs, evidence
links, idempotency keys, and foreign keys are relational columns/tables.

Every JSONB value is schema-validated at ingress. Size limits and sensitive-key
redaction apply before insertion. JSONB is never deserialized into a trusted
runtime authorization.

## 10. Append-only tables

Normal application roles receive `INSERT`/`SELECT`, not `UPDATE`/`DELETE`, for:

- evidence, candidate, grounding, policy, plan, and plan-step records;
- execution events and operation attempts;
- safety events;
- observations and verification versions;
- failure audit events and their evidence joins;
- reward events;
- verified-memory versions and sources.

Cues are logically append-only, but privacy retention may redact or remove raw
payload while preserving cue identity, source identity hash, timestamps, and
deduplication metadata. Corrections to ledgers are new compensating events.

## 11. Mutable current-state tables

- `cognitive_sessions`: phase, failure/retry counts, cooldown, current pointers,
  and `row_version`.
- `execution_safety_state`: fail-closed durable status, generation, and last
  evaluation references; updated only with expected generation.
- `executions`: current status, step, timestamps, error, and `row_version`.
- `execution_step_state`: current per-step state and row version.
- `execution_operations`: current logical outcome, attempt count, provider
  reference, reconciliation state, and row version.
- `learning_state`: derived aggregates and row version.
- `verified_memory_heads`: current verified version pointer and row version.
- `idempotency_records`: restricted `IN_PROGRESS -> COMPLETED/FAILED/UNKNOWN`
  transitions; request hash is immutable.

Every mutable table has `updated_at` and an integer `row_version` unless safety
generation itself is the concurrency version.

## 12. Runtime-only state

Never persist:

- the private authorization symbol/brand;
- an `AllowedExecutionSafetyState` object;
- a runtime capability/token or a boolean meaning “may execute”;
- in-process locks, promises, leases without durable expiry semantics, or worker
  object references;
- model scratch state or chain-of-thought.

A stored policy outcome of `ALLOW` and grounding status of `VERIFIED` are audit
facts. Neither is an executable capability.

## 13. Optimistic concurrency model

All commands carry an expected current version. PostgreSQL performs the check
and update in one statement, not a `SELECT` followed by an unconditional update.

Safety transition pattern:

```sql
UPDATE execution_safety_state
SET generation = generation + 1,
    durable_status = $new_status,
    updated_at = $now
WHERE session_id = $session_id
  AND generation = $expected_generation
RETURNING generation;
```

Zero returned rows means stale/missing state. The worker stops and reloads; it
does not overwrite the winner. The corresponding safety event is inserted in
the same transaction with `UNIQUE(session_id, to_generation)`.

Other mutable rows use the same pattern with `row_version`. `SELECT ... FOR
UPDATE` may be used inside a transaction for composing several dependent rows,
but it does not replace conditional writes or unique constraints.

## 14. Safety-generation invariant

For each session, generation is monotonic and never reused:

```text
read current generation N
domain validates transition from N
conditional transaction writes N + 1
transaction commits
only then may a runtime authorization for N + 1 be used
```

Failure recovery atomically advances to `N + 1` and durable `BLOCKED`, making
every authorization at `N` stale. Runtime authorization issuance also advances
generation. The durable row remains fail-closed (`UNAUTHORIZED`) and stores only
evaluation references; the runtime brand exists only in the live process.

If a process crashes after the generation commit but before using its runtime
authorization, no permission survives. A new worker re-evaluates grounding and
policy and advances the generation again. An execution-start update includes
the expected safety generation, so a concurrent revocation makes it affect zero
rows.

## 15. Idempotency model

Idempotency answers whether the logical command already happened; concurrency
answers whether its input state is still current; a transaction makes all
related writes atomic.

Rules:

- Assign stable command/event/operation IDs before the first attempt and reuse
  them for every retry.
- Store an immutable request fingerprint with idempotency keys. Reusing a key
  with a different fingerprint is a conflict, never a replay.
- Prefer a domain-table unique constraint; use `idempotency_records` for API or
  multi-row command replay results.
- `INSERT ... ON CONFLICT DO NOTHING/UPDATE` is followed by reading the existing
  logical result. Do not generate a new key after a timeout.
- Attempt number is diagnostic history. It never changes logical operation
  identity.
- Expiring generic request-idempotency rows must not remove permanent domain
  uniqueness needed to prevent duplicate effects or ledger entries.

## 16. Cue deduplication

Every ingress adapter must produce `source` and a stable `external_event_id`:
provider event ID, email message/event ID, GitHub delivery/event ID, stable file
event identity, schedule ID plus occurrence time, or a client request ID.

One transaction:

1. `INSERT cues ... ON CONFLICT (source, external_event_id) DO NOTHING RETURNING cue_id`.
2. Only when inserted, create the initial cognitive session and initial safety
   row at generation `0`, durable status `UNAUTHORIZED`.
3. If conflicted, return the existing cue/session identity without creating new
   work.

Two workers may both receive the webhook; the unique index chooses one logical
cue. Application-side “exists” checks are only optimizations.

## 17. Execution-step idempotency

The logical operation identity is:

```text
(execution_id, step_id, operation_generation)
```

`operation_generation` starts at `1` and changes only when policy/domain logic
explicitly authorizes a new logical side effect. A timeout retry keeps the same
operation generation and `operation_id`; it only appends a new attempt.

Before calling a provider, insert/reserve `execution_operations` with its unique
key and request fingerprint. Send `operation_id` (or a deterministic derivative)
as the provider idempotency key when supported. A retry that finds `SUCCEEDED`
returns the recorded result; `IN_FLIGHT` obeys lease/reconciliation rules;
`UNKNOWN` reconciles before another non-idempotent call.

## 18. Reward deduplication

Each reward-producing rule has a stable `reward_rule_id`. The logical key is
`(verification_id, reward_rule_id)`, with execution consistency enforced by a
composite FK.

In one transaction, an insert CTE uses `ON CONFLICT DO NOTHING`; the learning
aggregate changes only when the CTE inserted a row. Retrying a command therefore
cannot award `+10` repeatedly. Corrections are new reward events with distinct
rules/signals, never edits to the original reward.

## 19. Audit deduplication

The failure command receives a stable `logical_failure_key`, created when the
failure is first recognized and reused across retry. `audit_event_id` is also
stable. The database enforces both the logical key and the revoked generation.

An append-only ledger does not permit duplicate logical facts. On retry after a
successful commit, the existing audit/recovery result is returned. On conflict
with different content/fingerprint, fail closed and investigate.

## 20. Transaction boundaries

### Cue ingestion

Deduplicated cue insert, initial session, and initial safety row commit together.

### Failure recovery

One transaction performs:

1. idempotent failure-command reservation/audit insert;
2. safety `expected N -> N+1 BLOCKED` conditional update;
3. safety transition event append;
4. active execution `PENDING/RUNNING -> BLOCKED` conditional update and event;
5. cognitive phase/counters/cooldown update using expected session row version.

Any zero-row stale update or constraint failure rolls back every write. Audit is
logically created before ephemeral clearing, while its durable insert and all
current-state changes commit atomically.

### Reward append

Verification check, unique reward insert, and conditional learning aggregate
update commit together. No inserted reward means no aggregate increment.

### Execution start

After the in-process domain guard validates the private authorization, one
transaction conditionally updates `PENDING -> RUNNING` only when execution row
version, plan ID/candidate, session ID, and current safety generation all match.
It also initializes step state and appends the execution event. A concurrent
revocation makes the update return zero rows.

### Safety authorization issuance

Grounding and policy facts are already immutable. The transition conditionally
advances generation and stores their references while durable status remains
`UNAUTHORIZED`; a history event records that runtime evaluation occurred. The
runtime authorization may be used only after commit succeeds. On rollback or
stale conflict, discard it.

### Cooldown transition/resume

Entering cooldown writes phase, deadline, counters, row version, and safety
revocation in the failure transaction. Resume conditionally updates only when
phase is `COOLDOWN`, persisted deadline is at/before injected `now`, retry budget
remains, and row version matches.

## 21. Failure / execution / audit correlation

`failure_audit_events` needs these first-class nullable relationships:

- `session_id` required;
- `candidate_id`, `plan_id`, `execution_id`, and `step_id` when known;
- `failure_code`, original cognitive phase, failure/retry counts;
- `from_safety_generation` and `revoked_safety_generation` required;
- recovery action and auditable reason summary;
- occurrence/creation timestamp and logical failure key.

Foreign keys and composite plan/step relationships prevent contradictory
correlation. `failure_audit_evidence` references durable evidence IDs. Execution
and safety events share the same failure/audit ID, allowing reconstruction of
what failed, where execution stopped, which generation was revoked, and what
recovery was selected without recording chain-of-thought.

## 22. Reward ledger

`reward_events` is immutable and authoritative. It stores signal, finite value,
reason summary, verification, execution, rule/idempotency identity, and time.
Learning aggregates are projections only and can be rebuilt by replaying the
ledger. Normal application roles cannot update or delete reward rows.

## 23. Verified-memory rules

A memory admission command must reference durable verified evidence, typically
a `VERIFIED` result verification, trusted human evidence, or an approved policy
fact. The adapter verifies the referenced boundary and writes an immutable new
memory version plus source joins. It conditionally advances the memory head.

Facts, validated procedures, approved policy-derived memory, and validated
skills may be stored. A correction creates a superseding version. Confidence,
verification timestamp, source evidence, admission rule/version, and creation
time are mandatory. Candidate confidence, model output, or temporary assumptions
alone can never satisfy the admission boundary.

## 24. Data that MUST NOT be persisted

- Chain-of-thought, hidden reasoning, unrestricted scratch text, or model token
  traces.
- Temporary assumptions, failed hypotheses, unevaluated retrieved context, and
  speculative candidate reasoning.
- `AgentContext.workingMemory` as a general JSON snapshot.
- Private authorization brand/token or a trusted serialized `ALLOWED` object.
- Secrets, credentials, raw authorization headers, session cookies, or provider
  tokens in payload/metadata JSONB.
- Unbounded raw provider responses when a minimal summary, identifiers, and
  evidence references suffice.

Persist decisions, concise reason summaries, evidence references, policy IDs,
statuses, and result metadata instead.

## 25. Runtime authorization rehydration rule

There is no direct authorization rehydration.

```text
load fail-closed durable state and generation N
→ validate current session is eligible
→ retrieve durable grounding/evidence/policy facts
→ freshly re-ground and re-evaluate policy
→ domain creates candidate-bound authorization for N+1
→ conditional transaction commits generation N+1
→ only then use the private runtime capability
```

An object parsed from storage or a queue with `status: "ALLOWED"` is untrusted
input and must fail validation. A stored historical policy `ALLOW` is never
sufficient by itself. Restart therefore invalidates practical possession of all
old runtime authorizations, and the next transition advances generation.

## 26. Multi-worker behavior

- Workers may read concurrently, but only a conditional update can claim a
  current-state transition.
- Worker A reading generation `7` loses after worker B commits `7 -> 8`; A's
  `WHERE generation = 7` update affects zero rows and A stops.
- Execution and session row versions prevent two workers from advancing one
  execution or cognitive phase independently.
- Unique cue, operation, audit, verification, and reward keys resolve concurrent
  duplicate inserts.
- Operation leases, when introduced, are durable owner/expiry columns acquired
  conditionally. Process-local locks are never correctness mechanisms.
- Serializable isolation is not required for every command when conditional
  writes and constraints fully encode the invariant; use stronger isolation for
  a transaction only when a cross-row invariant cannot otherwise be expressed.

## 27. Crash recovery scenarios

### 1. Crash while execution is pending

The cue, session, plan, `PENDING` execution, operation IDs, and current safety
generation survive. A worker reloads them, re-evaluates runtime authorization,
and conditionally claims `PENDING -> RUNNING`. Row version and generation checks
prevent duplicate starts.

### 2. Crash while execution is running

`RUNNING` means the worker started, not that an external effect succeeded or
failed. Inspect the current operation and latest attempt. Expired `IN_FLIGHT`
work becomes `UNKNOWN`/reconciliation-required; do not blindly issue the effect
again. Execution remains blocked from success until observations verify outcome.

### 3. Crash during cooldown

Phase, retry counts, and `cooldown_until` are durable. Restart does not reset the
deadline. Resume uses the stored deadline, injected current time, retry budget,
and a conditional session update.

### 4. Crash immediately after failure

Audit, safety revocation, execution block, execution/safety events, and cognitive
recovery commit in one transaction. The database contains either all or none.
Retrying the same failure key returns the committed result.

### 5. Stale worker

The stale expected generation/row version causes a zero-row update. The worker
stops, discards runtime authorization, and reloads; it never performs an
unconditional overwrite.

### 6. Duplicate cue

Concurrent inserts race on `(source, external_event_id)`. One creates the cue
and session; the other receives the existing logical identity.

### 7. Duplicate tool execution

Retries reuse `(execution_id, step_id, operation_generation)` and the same
provider idempotency key. They append attempts to one operation rather than
creating another logical effect.

### 8. Crash after external side effect

The operation remains `IN_FLIGHT` or becomes `UNKNOWN`. Query the provider by
idempotency key/provider operation ID or observe the target system. Mark success
only from evidence. If outcome cannot be reconciled and the provider is not
idempotent, do not repeat automatically; block/escalate.

## 28. External side-effect uncertainty / reconciliation

Crossing a database/provider boundary cannot generally provide true exactly-once
effects.

Case A:

```text
operation PENDING/IN_FLIGHT persisted
→ provider accepts side effect
→ worker crashes before local success commit
→ retry sees uncertain durable operation
```

Recovery priority:

1. Reuse a provider-native idempotency key derived from our stable operation ID.
2. Store provider request fingerprint and provider operation/reference ID.
3. Query provider status or observe the external target before retrying.
4. Record an immutable observation and reconcile to `SUCCEEDED`, `FAILED`, or
   `UNKNOWN`.
5. If no safe reconciliation exists, retain `UNKNOWN`, block autonomous retry,
   and request human review.

The target is effectively-once logical execution under at-least-once delivery,
not an unsupported claim of global exactly-once side effects.

## 29. Retention considerations

Long-lived by default: failure/safety/execution audit history, reward ledger,
verified-memory versions and sources, essential execution/operation identity,
and policy/grounding decision summaries required for audit.

Potentially shorter-lived: raw cue payloads, observation JSONB, provider
request/response metadata, attempt debug detail, and large evidence bodies.
Preserve stable IDs, hashes, timestamps, outcome summaries, and deduplication
keys after payload expiry when lawful and necessary.

Apply field-level minimization, redaction before persistence, access controls,
and explicit retention timestamps. Avoid unnecessary sensitive data. Deletion or
legal erasure should use a controlled policy that preserves non-sensitive ledger
integrity or tombstones rather than silently rewriting history.

## 30. Recommended implementation order

1. Add persistence-facing domain commands/records and validation codecs for the
   missing stable IDs, timestamps, correlation fields, and expected versions.
2. Select a stable PostgreSQL driver/migration approach and create migrations
   for cues, sessions, safety current/history, executions, operations, and
   failure audits with constraints first.
3. Implement the idempotent cue-ingestion transaction and concurrency tests.
4. Implement safety generation compare-and-swap plus failure-recovery transaction
   and stale-worker integration tests.
5. Implement execution start, step operation idempotency, attempt history, and
   reconciliation states.
6. Add observations and versioned result verification.
7. Add reward ledger plus atomic learning projection.
8. Add verified-memory admission/versioning.
9. Add retention jobs and least-privilege database roles after data paths exist.

The single next task should be step 1: define persistence-facing records,
commands, and Zod codecs for stable identities and expected versions without
installing a database library. This closes current domain-shape gaps before a
migration hardens the wrong schema.
