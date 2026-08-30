CREATE TABLE "cues" (
	"cue_id" varchar(256) PRIMARY KEY NOT NULL,
	"source" varchar(256) NOT NULL,
	"external_event_id" varchar(256) NOT NULL,
	"cue_type" varchar(256) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_expires_at" timestamp with time zone,
	"payload_hash" varchar(512),
	CONSTRAINT "cues_source_external_event_id_unique" UNIQUE("source","external_event_id"),
	CONSTRAINT "cues_source_non_empty" CHECK (length(trim("cues"."source")) > 0),
	CONSTRAINT "cues_external_event_id_non_empty" CHECK (length(trim("cues"."external_event_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "cognitive_sessions" (
	"session_id" varchar(256) PRIMARY KEY NOT NULL,
	"cue_id" varchar(256) NOT NULL,
	"phase" varchar(64) NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 0 NOT NULL,
	"cooldown_until" timestamp with time zone,
	"current_candidate_id" varchar(256),
	"current_plan_id" varchar(256),
	"current_execution_id" varchar(256),
	"row_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cognitive_sessions_cue_id_unique" UNIQUE("cue_id"),
	CONSTRAINT "cognitive_sessions_failure_count_non_negative" CHECK ("cognitive_sessions"."failure_count" >= 0),
	CONSTRAINT "cognitive_sessions_retry_count_non_negative" CHECK ("cognitive_sessions"."retry_count" >= 0),
	CONSTRAINT "cognitive_sessions_max_retries_non_negative" CHECK ("cognitive_sessions"."max_retries" >= 0),
	CONSTRAINT "cognitive_sessions_retry_within_max" CHECK ("cognitive_sessions"."retry_count" <= "cognitive_sessions"."max_retries"),
	CONSTRAINT "cognitive_sessions_row_version_non_negative" CHECK ("cognitive_sessions"."row_version" >= 0),
	CONSTRAINT "cognitive_sessions_phase_cooldown_invariant" CHECK (("cognitive_sessions"."phase" = 'COOLDOWN' AND "cognitive_sessions"."cooldown_until" IS NOT NULL) OR ("cognitive_sessions"."phase" <> 'COOLDOWN' AND "cognitive_sessions"."cooldown_until" IS NULL)),
	CONSTRAINT "cognitive_sessions_phase_valid" CHECK ("cognitive_sessions"."phase" IN ('CUE', 'PERCEIVE', 'BUILD_CONTEXT', 'RETRIEVE_MEMORY', 'GENERATE_CANDIDATES', 'SCORE', 'GROUND_VERIFY', 'POLICY_SAFETY', 'PLAN', 'DURABLE_EXECUTION', 'ACT', 'OBSERVE', 'VERIFY_RESULT', 'REWARD', 'LEARN', 'SAVE_MEMORY', 'CLEAR_WORKING_MEMORY', 'COOLDOWN', 'HUMAN_REVIEW', 'IDLE'))
);
--> statement-breakpoint
CREATE TABLE "candidate_actions" (
	"candidate_id" varchar(256) PRIMARY KEY NOT NULL,
	"session_id" varchar(256) NOT NULL,
	"cue_id" varchar(256) NOT NULL,
	"goal" text NOT NULL,
	"action" text NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"expected_utility" numeric(5, 4) NOT NULL,
	"estimated_risk" numeric(5, 4) NOT NULL,
	"estimated_cost" numeric(5, 4) NOT NULL,
	"score_value" numeric(5, 4) NOT NULL,
	"recommendation" varchar(64) NOT NULL,
	"score_formula_version" varchar(256) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "candidate_actions_session_candidate_unique" UNIQUE("session_id","candidate_id"),
	CONSTRAINT "candidate_actions_confidence_range" CHECK ("candidate_actions"."confidence" >= 0 AND "candidate_actions"."confidence" <= 1),
	CONSTRAINT "candidate_actions_expected_utility_range" CHECK ("candidate_actions"."expected_utility" >= 0 AND "candidate_actions"."expected_utility" <= 1),
	CONSTRAINT "candidate_actions_estimated_risk_range" CHECK ("candidate_actions"."estimated_risk" >= 0 AND "candidate_actions"."estimated_risk" <= 1),
	CONSTRAINT "candidate_actions_estimated_cost_range" CHECK ("candidate_actions"."estimated_cost" >= 0 AND "candidate_actions"."estimated_cost" <= 1),
	CONSTRAINT "candidate_actions_score_value_range" CHECK ("candidate_actions"."score_value" >= 0 AND "candidate_actions"."score_value" <= 1)
);
--> statement-breakpoint
CREATE TABLE "candidate_evidence" (
	"candidate_id" varchar(256) NOT NULL,
	"evidence_id" varchar(256) NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "candidate_evidence_pk" PRIMARY KEY("candidate_id","evidence_id"),
	CONSTRAINT "candidate_evidence_ordinal_non_negative" CHECK ("candidate_evidence"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "evidence_records" (
	"evidence_id" varchar(256) PRIMARY KEY NOT NULL,
	"source" varchar(256) NOT NULL,
	"source_id" varchar(256) NOT NULL,
	"claim" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"provider_metadata" jsonb,
	CONSTRAINT "evidence_records_source_non_empty" CHECK (length(trim("evidence_records"."source")) > 0),
	CONSTRAINT "evidence_records_source_id_non_empty" CHECK (length(trim("evidence_records"."source_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "grounding_result_evidence" (
	"grounding_result_id" varchar(256) NOT NULL,
	"evidence_id" varchar(256) NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "grounding_result_evidence_pk" PRIMARY KEY("grounding_result_id","evidence_id"),
	CONSTRAINT "grounding_result_evidence_ordinal_non_negative" CHECK ("grounding_result_evidence"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "grounding_results" (
	"grounding_result_id" varchar(256) PRIMARY KEY NOT NULL,
	"candidate_id" varchar(256) NOT NULL,
	"evaluation_key" varchar(512) NOT NULL,
	"status" varchar(64) NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"reason" text NOT NULL,
	"evaluator_version" varchar(256) NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "grounding_results_candidate_evaluation_key_unique" UNIQUE("candidate_id","evaluation_key"),
	CONSTRAINT "grounding_results_status_valid" CHECK ("grounding_results"."status" IN ('VERIFIED', 'CONTRADICTED', 'UNVERIFIED')),
	CONSTRAINT "grounding_results_confidence_range" CHECK ("grounding_results"."confidence" >= 0 AND "grounding_results"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "policy_decision_policy_refs" (
	"policy_decision_id" varchar(256) NOT NULL,
	"policy_id" varchar(256) NOT NULL,
	CONSTRAINT "policy_decision_policy_refs_pk" PRIMARY KEY("policy_decision_id","policy_id")
);
--> statement-breakpoint
CREATE TABLE "policy_decisions" (
	"policy_decision_id" varchar(256) PRIMARY KEY NOT NULL,
	"candidate_id" varchar(256) NOT NULL,
	"grounding_result_id" varchar(256) NOT NULL,
	"evaluation_key" varchar(512) NOT NULL,
	"outcome" varchar(64) NOT NULL,
	"reason" text NOT NULL,
	"policy_engine_version" varchar(256) NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "policy_decisions_candidate_evaluation_key_unique" UNIQUE("candidate_id","evaluation_key"),
	CONSTRAINT "policy_decisions_outcome_valid" CHECK ("policy_decisions"."outcome" IN ('ALLOW', 'REQUIRE_HUMAN_CONFIRMATION', 'DENY'))
);
--> statement-breakpoint
CREATE TABLE "action_plan_step_dependencies" (
	"plan_id" varchar(256) NOT NULL,
	"step_id" varchar(256) NOT NULL,
	"depends_on_step_id" varchar(256) NOT NULL,
	CONSTRAINT "action_plan_step_dependencies_pk" PRIMARY KEY("plan_id","step_id","depends_on_step_id"),
	CONSTRAINT "action_plan_step_dependencies_no_self_dependency" CHECK ("action_plan_step_dependencies"."step_id" <> "action_plan_step_dependencies"."depends_on_step_id")
);
--> statement-breakpoint
CREATE TABLE "action_plan_steps" (
	"plan_id" varchar(256) NOT NULL,
	"step_id" varchar(256) NOT NULL,
	"ordinal" integer NOT NULL,
	"description" text NOT NULL,
	CONSTRAINT "action_plan_steps_pk" PRIMARY KEY("plan_id","step_id"),
	CONSTRAINT "action_plan_steps_plan_ordinal_unique" UNIQUE("plan_id","ordinal"),
	CONSTRAINT "action_plan_steps_ordinal_non_negative" CHECK ("action_plan_steps"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "action_plans" (
	"plan_id" varchar(256) PRIMARY KEY NOT NULL,
	"candidate_id" varchar(256) NOT NULL,
	"plan_generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "action_plans_candidate_plan_generation_unique" UNIQUE("candidate_id","plan_generation"),
	CONSTRAINT "action_plans_plan_generation_positive" CHECK ("action_plans"."plan_generation" >= 1)
);
--> statement-breakpoint
CREATE TABLE "execution_events" (
	"execution_event_id" varchar(256) PRIMARY KEY NOT NULL,
	"execution_id" varchar(256) NOT NULL,
	"transition_sequence" bigint NOT NULL,
	"from_status" varchar(64),
	"to_status" varchar(64) NOT NULL,
	"step_id" varchar(256),
	"safety_generation" bigint,
	"operation_id" varchar(256),
	"event_key" varchar(512) NOT NULL,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "execution_events_execution_transition_sequence_unique" UNIQUE("execution_id","transition_sequence"),
	CONSTRAINT "execution_events_event_key_unique" UNIQUE("event_key"),
	CONSTRAINT "execution_events_transition_sequence_non_negative" CHECK ("execution_events"."transition_sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "execution_operation_attempts" (
	"attempt_id" varchar(256) PRIMARY KEY NOT NULL,
	"operation_id" varchar(256) NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" varchar(64) NOT NULL,
	"worker_id" varchar(256),
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"error_summary" text,
	"provider_metadata" jsonb,
	CONSTRAINT "execution_operation_attempts_operation_attempt_number_unique" UNIQUE("operation_id","attempt_number"),
	CONSTRAINT "execution_operation_attempts_attempt_number_positive" CHECK ("execution_operation_attempts"."attempt_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "execution_operations" (
	"operation_id" varchar(256) PRIMARY KEY NOT NULL,
	"execution_id" varchar(256) NOT NULL,
	"step_id" varchar(256) NOT NULL,
	"operation_generation" integer DEFAULT 1 NOT NULL,
	"operation_kind" varchar(256) NOT NULL,
	"operation_idempotency_key" varchar(512) NOT NULL,
	"request_fingerprint" varchar(512) NOT NULL,
	"status" varchar(64) NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"provider_scope" varchar(256),
	"provider_idempotency_key" varchar(512),
	"provider_operation_id" varchar(256),
	"uncertainty_reason" text,
	"reconciliation_status" varchar(64) DEFAULT 'NOT_REQUIRED' NOT NULL,
	"reconciliation_outcome" text,
	"result_metadata" jsonb,
	"row_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "execution_operations_execution_step_generation_unique" UNIQUE("execution_id","step_id","operation_generation"),
	CONSTRAINT "execution_operations_operation_idempotency_key_unique" UNIQUE("operation_idempotency_key"),
	CONSTRAINT "execution_operations_status_valid" CHECK ("execution_operations"."status" IN ('PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
	CONSTRAINT "execution_operations_reconciliation_status_valid" CHECK ("execution_operations"."reconciliation_status" IN ('NOT_REQUIRED', 'REQUIRED', 'RECONCILED')),
	CONSTRAINT "execution_operations_operation_generation_positive" CHECK ("execution_operations"."operation_generation" >= 1),
	CONSTRAINT "execution_operations_attempt_count_non_negative" CHECK ("execution_operations"."attempt_count" >= 0),
	CONSTRAINT "execution_operations_row_version_non_negative" CHECK ("execution_operations"."row_version" >= 0),
	CONSTRAINT "execution_operations_unknown_uncertainty_invariant" CHECK (("execution_operations"."status" = 'UNKNOWN' AND "execution_operations"."uncertainty_reason" IS NOT NULL) OR ("execution_operations"."status" <> 'UNKNOWN' AND "execution_operations"."uncertainty_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "execution_step_state" (
	"execution_id" varchar(256) NOT NULL,
	"plan_id" varchar(256) NOT NULL,
	"step_id" varchar(256) NOT NULL,
	"status" varchar(64) NOT NULL,
	"operation_generation" integer DEFAULT 1 NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "execution_step_state_pk" PRIMARY KEY("execution_id","step_id"),
	CONSTRAINT "execution_step_state_status_valid" CHECK ("execution_step_state"."status" IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED')),
	CONSTRAINT "execution_step_state_operation_generation_positive" CHECK ("execution_step_state"."operation_generation" >= 1),
	CONSTRAINT "execution_step_state_row_version_non_negative" CHECK ("execution_step_state"."row_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"execution_id" varchar(256) PRIMARY KEY NOT NULL,
	"session_id" varchar(256) NOT NULL,
	"plan_id" varchar(256) NOT NULL,
	"status" varchar(64) NOT NULL,
	"current_step_id" varchar(256),
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text,
	"safety_generation_at_start" bigint,
	"row_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "executions_status_valid" CHECK ("executions"."status" IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED')),
	CONSTRAINT "executions_row_version_non_negative" CHECK ("executions"."row_version" >= 0),
	CONSTRAINT "executions_safety_generation_at_start_valid" CHECK ("executions"."safety_generation_at_start" IS NULL OR ("executions"."safety_generation_at_start" >= 0 AND "executions"."safety_generation_at_start" <= 9007199254740991)),
	CONSTRAINT "executions_status_timestamp_invariant" CHECK (("executions"."status" = 'PENDING' AND "executions"."started_at" IS NULL AND "executions"."completed_at" IS NULL) OR ("executions"."status" = 'RUNNING' AND "executions"."started_at" IS NOT NULL AND "executions"."completed_at" IS NULL AND "executions"."safety_generation_at_start" IS NOT NULL) OR ("executions"."status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND "executions"."completed_at" IS NOT NULL) OR ("executions"."status" = 'BLOCKED' AND "executions"."completed_at" IS NOT NULL AND "executions"."error" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "execution_safety_events" (
	"safety_event_id" varchar(256) PRIMARY KEY NOT NULL,
	"session_id" varchar(256) NOT NULL,
	"from_generation" bigint NOT NULL,
	"to_generation" bigint NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"candidate_id" varchar(256),
	"grounding_result_id" varchar(256),
	"policy_decision_id" varchar(256),
	"failure_audit_event_id" varchar(256),
	"event_key" varchar(512) NOT NULL,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "execution_safety_events_session_to_generation_unique" UNIQUE("session_id","to_generation"),
	CONSTRAINT "execution_safety_events_event_key_unique" UNIQUE("event_key"),
	CONSTRAINT "execution_safety_events_from_generation_safe_range" CHECK ("execution_safety_events"."from_generation" >= 0 AND "execution_safety_events"."from_generation" <= 9007199254740991),
	CONSTRAINT "execution_safety_events_to_generation_safe_range" CHECK ("execution_safety_events"."to_generation" >= 0 AND "execution_safety_events"."to_generation" <= 9007199254740991),
	CONSTRAINT "execution_safety_events_generation_advance_exact_one" CHECK ("execution_safety_events"."to_generation" = "execution_safety_events"."from_generation" + 1)
);
--> statement-breakpoint
CREATE TABLE "execution_safety_state" (
	"session_id" varchar(256) PRIMARY KEY NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"durable_status" varchar(64) DEFAULT 'UNAUTHORIZED' NOT NULL,
	"failure_code" varchar(64),
	"reason" text NOT NULL,
	"blocked_at" timestamp with time zone,
	"evaluated_candidate_id" varchar(256),
	"grounding_result_id" varchar(256),
	"policy_decision_id" varchar(256),
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "execution_safety_state_status_fail_closed" CHECK ("execution_safety_state"."durable_status" IN ('UNAUTHORIZED', 'BLOCKED')),
	CONSTRAINT "execution_safety_state_generation_safe_range" CHECK ("execution_safety_state"."generation" >= 0 AND "execution_safety_state"."generation" <= 9007199254740991),
	CONSTRAINT "execution_safety_state_status_fields_invariant" CHECK (("execution_safety_state"."durable_status" = 'UNAUTHORIZED' AND "execution_safety_state"."failure_code" IS NULL AND "execution_safety_state"."blocked_at" IS NULL) OR ("execution_safety_state"."durable_status" = 'BLOCKED' AND "execution_safety_state"."failure_code" IS NOT NULL AND "execution_safety_state"."blocked_at" IS NOT NULL)),
	CONSTRAINT "execution_safety_state_evaluation_refs_all_or_none" CHECK (("execution_safety_state"."evaluated_candidate_id" IS NULL AND "execution_safety_state"."grounding_result_id" IS NULL AND "execution_safety_state"."policy_decision_id" IS NULL) OR ("execution_safety_state"."evaluated_candidate_id" IS NOT NULL AND "execution_safety_state"."grounding_result_id" IS NOT NULL AND "execution_safety_state"."policy_decision_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "failure_audit_events" (
	"audit_event_id" varchar(256) PRIMARY KEY NOT NULL,
	"logical_failure_key" varchar(512) NOT NULL,
	"session_id" varchar(256) NOT NULL,
	"candidate_id" varchar(256),
	"plan_id" varchar(256),
	"execution_id" varchar(256),
	"step_id" varchar(256),
	"failure_code" varchar(64) NOT NULL,
	"original_phase" varchar(64) NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"from_safety_generation" bigint NOT NULL,
	"revoked_safety_generation" bigint NOT NULL,
	"recovery_action" varchar(64) NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "failure_audit_events_session_logical_key_unique" UNIQUE("session_id","logical_failure_key"),
	CONSTRAINT "failure_audit_events_session_revoked_generation_unique" UNIQUE("session_id","revoked_safety_generation"),
	CONSTRAINT "failure_audit_events_failure_count_non_negative" CHECK ("failure_audit_events"."failure_count" >= 0),
	CONSTRAINT "failure_audit_events_retry_count_non_negative" CHECK ("failure_audit_events"."retry_count" >= 0),
	CONSTRAINT "failure_audit_events_from_generation_safe_range" CHECK ("failure_audit_events"."from_safety_generation" >= 0 AND "failure_audit_events"."from_safety_generation" <= 9007199254740991),
	CONSTRAINT "failure_audit_events_revoked_generation_safe_range" CHECK ("failure_audit_events"."revoked_safety_generation" >= 0 AND "failure_audit_events"."revoked_safety_generation" <= 9007199254740991),
	CONSTRAINT "failure_audit_events_failure_code_valid" CHECK ("failure_audit_events"."failure_code" IN ('HALLUCINATION_DETECTED', 'POLICY_VIOLATION', 'EXECUTION_TIMEOUT', 'UNVERIFIED_RESULT')),
	CONSTRAINT "failure_audit_events_recovery_action_valid" CHECK ("failure_audit_events"."recovery_action" IN ('RETRY_WITH_FRESH_CONTEXT', 'START_COOLDOWN', 'ESCALATE_TO_HUMAN'))
);
--> statement-breakpoint
CREATE TABLE "failure_audit_evidence" (
	"audit_event_id" varchar(256) NOT NULL,
	"evidence_id" varchar(256) NOT NULL,
	CONSTRAINT "failure_audit_evidence_pk" PRIMARY KEY("audit_event_id","evidence_id")
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"observation_id" varchar(256) PRIMARY KEY NOT NULL,
	"execution_id" varchar(256) NOT NULL,
	"step_id" varchar(256),
	"source" varchar(256) NOT NULL,
	"source_event_id" varchar(256),
	"summary" text NOT NULL,
	"data" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"payload_expires_at" timestamp with time zone,
	CONSTRAINT "observations_execution_source_source_event_unique" UNIQUE("execution_id","source","source_event_id")
);
--> statement-breakpoint
CREATE TABLE "result_verification_observations" (
	"verification_id" varchar(256) NOT NULL,
	"observation_id" varchar(256) NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "result_verification_observations_pk" PRIMARY KEY("verification_id","observation_id"),
	CONSTRAINT "result_verification_observations_ordinal_non_negative" CHECK ("result_verification_observations"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "result_verifications" (
	"verification_id" varchar(256) PRIMARY KEY NOT NULL,
	"execution_id" varchar(256) NOT NULL,
	"verification_generation" integer DEFAULT 1 NOT NULL,
	"observation_set_digest" varchar(512) NOT NULL,
	"verifier_version" varchar(256) NOT NULL,
	"status" varchar(64) NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"reason" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	CONSTRAINT "result_verifications_execution_generation_unique" UNIQUE("execution_id","verification_generation"),
	CONSTRAINT "result_verifications_execution_digest_version_unique" UNIQUE("execution_id","observation_set_digest","verifier_version"),
	CONSTRAINT "result_verifications_generation_positive" CHECK ("result_verifications"."verification_generation" >= 1),
	CONSTRAINT "result_verifications_status_valid" CHECK ("result_verifications"."status" IN ('VERIFIED', 'FAILED', 'INCONCLUSIVE')),
	CONSTRAINT "result_verifications_confidence_range" CHECK ("result_verifications"."confidence" >= 0 AND "result_verifications"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "learning_state" (
	"skill_key" varchar(256) PRIMARY KEY NOT NULL,
	"confidence" numeric(5, 4) DEFAULT '0.5000' NOT NULL,
	"total_reward" numeric(12, 4) DEFAULT '0.0000' NOT NULL,
	"sample_count" bigint DEFAULT 0 NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "learning_state_confidence_range" CHECK ("learning_state"."confidence" >= 0 AND "learning_state"."confidence" <= 1),
	CONSTRAINT "learning_state_sample_count_non_negative" CHECK ("learning_state"."sample_count" >= 0),
	CONSTRAINT "learning_state_row_version_non_negative" CHECK ("learning_state"."row_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reward_events" (
	"reward_event_id" varchar(256) PRIMARY KEY NOT NULL,
	"reward_idempotency_key" varchar(512) NOT NULL,
	"execution_id" varchar(256) NOT NULL,
	"verification_id" varchar(256) NOT NULL,
	"reward_rule_id" varchar(256) NOT NULL,
	"signal" varchar(64) NOT NULL,
	"value" numeric(10, 4) NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reward_events_verification_rule_unique" UNIQUE("verification_id","reward_rule_id"),
	CONSTRAINT "reward_events_reward_idempotency_key_unique" UNIQUE("reward_idempotency_key"),
	CONSTRAINT "reward_events_signal_valid" CHECK ("reward_events"."signal" IN ('SUCCESS', 'HUMAN_APPROVAL', 'CORRECTION', 'FAILURE', 'HALLUCINATION', 'UNSAFE_ACTION'))
);
--> statement-breakpoint
CREATE TABLE "verified_memory" (
	"memory_id" varchar(256) PRIMARY KEY NOT NULL,
	"kind" varchar(64) NOT NULL,
	"memory_key" varchar(256) NOT NULL,
	"memory_version" integer DEFAULT 1 NOT NULL,
	"content" jsonb NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"admission_rule_version" varchar(256) NOT NULL,
	"supersedes_memory_id" varchar(256),
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verified_memory_kind_key_version_unique" UNIQUE("kind","memory_key","memory_version"),
	CONSTRAINT "verified_memory_kind_valid" CHECK ("verified_memory"."kind" IN ('FACT', 'POLICY', 'SKILL', 'PROCEDURE')),
	CONSTRAINT "verified_memory_version_positive" CHECK ("verified_memory"."memory_version" >= 1),
	CONSTRAINT "verified_memory_confidence_range" CHECK ("verified_memory"."confidence" >= 0 AND "verified_memory"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "verified_memory_heads" (
	"kind" varchar(64) NOT NULL,
	"memory_key" varchar(256) NOT NULL,
	"memory_id" varchar(256) NOT NULL,
	"memory_version" integer NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "verified_memory_heads_pk" PRIMARY KEY("kind","memory_key"),
	CONSTRAINT "verified_memory_heads_version_positive" CHECK ("verified_memory_heads"."memory_version" >= 1),
	CONSTRAINT "verified_memory_heads_row_version_non_negative" CHECK ("verified_memory_heads"."row_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "verified_memory_sources" (
	"memory_id" varchar(256) NOT NULL,
	"evidence_id" varchar(256) NOT NULL,
	CONSTRAINT "verified_memory_sources_pk" PRIMARY KEY("memory_id","evidence_id")
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"scope" varchar(256) NOT NULL,
	"idempotency_key" varchar(512) NOT NULL,
	"request_hash" varchar(512) NOT NULL,
	"status" varchar(64) NOT NULL,
	"result_resource_type" varchar(256),
	"result_resource_id" varchar(256),
	"error_code" varchar(256),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "idempotency_records_pk" PRIMARY KEY("scope","idempotency_key"),
	CONSTRAINT "idempotency_records_status_valid" CHECK ("idempotency_records"."status" IN ('IN_PROGRESS', 'COMPLETED', 'FAILED', 'UNKNOWN'))
);
--> statement-breakpoint
ALTER TABLE "cognitive_sessions" ADD CONSTRAINT "cognitive_sessions_cue_id_cues_cue_id_fk" FOREIGN KEY ("cue_id") REFERENCES "public"."cues"("cue_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_actions" ADD CONSTRAINT "candidate_actions_session_id_cognitive_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cognitive_sessions"("session_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_actions" ADD CONSTRAINT "candidate_actions_cue_id_cues_cue_id_fk" FOREIGN KEY ("cue_id") REFERENCES "public"."cues"("cue_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_evidence" ADD CONSTRAINT "candidate_evidence_candidate_id_candidate_actions_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_actions"("candidate_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_evidence" ADD CONSTRAINT "candidate_evidence_evidence_id_evidence_records_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence_records"("evidence_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grounding_result_evidence" ADD CONSTRAINT "grounding_result_evidence_grounding_result_id_grounding_results_grounding_result_id_fk" FOREIGN KEY ("grounding_result_id") REFERENCES "public"."grounding_results"("grounding_result_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grounding_result_evidence" ADD CONSTRAINT "grounding_result_evidence_evidence_id_evidence_records_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence_records"("evidence_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grounding_results" ADD CONSTRAINT "grounding_results_candidate_id_candidate_actions_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_actions"("candidate_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decision_policy_refs" ADD CONSTRAINT "policy_decision_policy_refs_policy_decision_id_policy_decisions_policy_decision_id_fk" FOREIGN KEY ("policy_decision_id") REFERENCES "public"."policy_decisions"("policy_decision_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_candidate_id_candidate_actions_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_actions"("candidate_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_grounding_result_id_grounding_results_grounding_result_id_fk" FOREIGN KEY ("grounding_result_id") REFERENCES "public"."grounding_results"("grounding_result_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_plan_step_dependencies" ADD CONSTRAINT "action_plan_step_dependencies_step_fk" FOREIGN KEY ("plan_id","step_id") REFERENCES "public"."action_plan_steps"("plan_id","step_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_plan_step_dependencies" ADD CONSTRAINT "action_plan_step_dependencies_depends_on_step_fk" FOREIGN KEY ("plan_id","depends_on_step_id") REFERENCES "public"."action_plan_steps"("plan_id","step_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_plan_steps" ADD CONSTRAINT "action_plan_steps_plan_id_action_plans_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."action_plans"("plan_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_plans" ADD CONSTRAINT "action_plans_candidate_id_candidate_actions_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_actions"("candidate_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_execution_id_executions_execution_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("execution_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_operation_attempts" ADD CONSTRAINT "execution_operation_attempts_operation_id_execution_operations_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."execution_operations"("operation_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_operations" ADD CONSTRAINT "execution_operations_execution_id_executions_execution_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("execution_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_step_state" ADD CONSTRAINT "execution_step_state_execution_id_executions_execution_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("execution_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_step_state" ADD CONSTRAINT "execution_step_state_step_fk" FOREIGN KEY ("plan_id","step_id") REFERENCES "public"."action_plan_steps"("plan_id","step_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_session_id_cognitive_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cognitive_sessions"("session_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_plan_id_action_plans_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."action_plans"("plan_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_safety_events" ADD CONSTRAINT "execution_safety_events_session_id_cognitive_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cognitive_sessions"("session_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_safety_state" ADD CONSTRAINT "execution_safety_state_session_id_cognitive_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cognitive_sessions"("session_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failure_audit_events" ADD CONSTRAINT "failure_audit_events_session_id_cognitive_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cognitive_sessions"("session_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failure_audit_evidence" ADD CONSTRAINT "failure_audit_evidence_audit_event_id_failure_audit_events_audit_event_id_fk" FOREIGN KEY ("audit_event_id") REFERENCES "public"."failure_audit_events"("audit_event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failure_audit_evidence" ADD CONSTRAINT "failure_audit_evidence_evidence_id_evidence_records_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence_records"("evidence_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_execution_id_executions_execution_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("execution_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_verification_observations" ADD CONSTRAINT "result_verification_observations_verification_id_result_verifications_verification_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."result_verifications"("verification_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_verification_observations" ADD CONSTRAINT "result_verification_observations_observation_id_observations_observation_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("observation_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_verifications" ADD CONSTRAINT "result_verifications_execution_id_executions_execution_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("execution_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_events" ADD CONSTRAINT "reward_events_execution_id_executions_execution_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("execution_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_events" ADD CONSTRAINT "reward_events_verification_id_result_verifications_verification_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."result_verifications"("verification_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verified_memory_heads" ADD CONSTRAINT "verified_memory_heads_memory_id_verified_memory_memory_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."verified_memory"("memory_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verified_memory_sources" ADD CONSTRAINT "verified_memory_sources_memory_id_verified_memory_memory_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."verified_memory"("memory_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verified_memory_sources" ADD CONSTRAINT "verified_memory_sources_evidence_id_evidence_records_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence_records"("evidence_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cognitive_sessions_cue_id_idx" ON "cognitive_sessions" USING btree ("cue_id");--> statement-breakpoint
CREATE INDEX "execution_operations_execution_id_idx" ON "execution_operations" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "execution_operations_status_idx" ON "execution_operations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "executions_session_id_idx" ON "executions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "executions_plan_id_idx" ON "executions" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "execution_safety_state_session_id_idx" ON "execution_safety_state" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "failure_audit_events_session_id_idx" ON "failure_audit_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "failure_audit_events_execution_id_idx" ON "failure_audit_events" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "observations_execution_id_idx" ON "observations" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "result_verifications_execution_id_idx" ON "result_verifications" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "reward_events_execution_id_idx" ON "reward_events" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "reward_events_verification_id_idx" ON "reward_events" USING btree ("verification_id");--> statement-breakpoint
CREATE INDEX "verified_memory_kind_key_idx" ON "verified_memory" USING btree ("kind","memory_key");