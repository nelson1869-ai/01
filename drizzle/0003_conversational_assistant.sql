CREATE TABLE "assistant_conversations" (
	"conversation_id" varchar(256) PRIMARY KEY NOT NULL,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "assistant_conversations_turn_count_non_negative" CHECK ("assistant_conversations"."turn_count" >= 0),
	CONSTRAINT "assistant_conversations_row_version_non_negative" CHECK ("assistant_conversations"."row_version" >= 0),
	CONSTRAINT "assistant_conversations_expiry_after_creation" CHECK ("assistant_conversations"."expires_at" > "assistant_conversations"."created_at")
);
--> statement-breakpoint
CREATE TABLE "assistant_turns" (
	"turn_id" varchar(256) PRIMARY KEY NOT NULL,
	"conversation_id" varchar(256) NOT NULL,
	"ordinal" integer NOT NULL,
	"user_message" text NOT NULL,
	"assistant_message" text,
	"kind" varchar(64),
	"status" varchar(64) NOT NULL,
	"decision_summary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cue_id" varchar(256),
	"session_id" varchar(256),
	"execution_id" varchar(256),
	"verification_id" varchar(256),
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "assistant_turns_conversation_ordinal_unique" UNIQUE("conversation_id","ordinal"),
	CONSTRAINT "assistant_turns_ordinal_positive" CHECK ("assistant_turns"."ordinal" >= 1),
	CONSTRAINT "assistant_turns_user_message_length" CHECK (length("assistant_turns"."user_message") BETWEEN 1 AND 8000),
	CONSTRAINT "assistant_turns_assistant_message_length" CHECK ("assistant_turns"."assistant_message" IS NULL OR length("assistant_turns"."assistant_message") BETWEEN 1 AND 12000),
	CONSTRAINT "assistant_turns_kind_valid" CHECK ("assistant_turns"."kind" IS NULL OR "assistant_turns"."kind" IN ('DIRECT_ANSWER', 'TOOL_REQUIRED', 'CLARIFICATION', 'DENIED')),
	CONSTRAINT "assistant_turns_status_valid" CHECK ("assistant_turns"."status" IN ('PROCESSING', 'COMPLETED', 'CLARIFICATION_REQUIRED', 'DENIED', 'FAILED', 'UNVERIFIED')),
	CONSTRAINT "assistant_turns_completion_invariant" CHECK (("assistant_turns"."status" = 'PROCESSING' AND "assistant_turns"."assistant_message" IS NULL AND "assistant_turns"."completed_at" IS NULL) OR ("assistant_turns"."status" <> 'PROCESSING' AND "assistant_turns"."assistant_message" IS NOT NULL AND "assistant_turns"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_conversation_id_assistant_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."assistant_conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_cue_id_cues_cue_id_fk" FOREIGN KEY ("cue_id") REFERENCES "public"."cues"("cue_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_session_id_cognitive_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cognitive_sessions"("session_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_execution_id_executions_execution_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("execution_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_verification_id_result_verifications_verification_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."result_verifications"("verification_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_conversations_expires_at_idx" ON "assistant_conversations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "assistant_turns_conversation_created_at_idx" ON "assistant_turns" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "assistant_turns_session_id_idx" ON "assistant_turns" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "assistant_turns_execution_id_idx" ON "assistant_turns" USING btree ("execution_id");