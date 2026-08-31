CREATE TABLE "authoritative_perception_snapshots" (
	"snapshot_id" varchar(256) PRIMARY KEY NOT NULL,
	"session_id" varchar(256) NOT NULL,
	"cue_id" varchar(256) NOT NULL,
	"evaluation_generation" integer NOT NULL,
	"summary" text NOT NULL,
	"structured_facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"target_spec" jsonb,
	"perceived_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "perception_snapshots_session_generation_unique" UNIQUE("session_id","evaluation_generation"),
	CONSTRAINT "perception_snapshots_generation_positive" CHECK ("authoritative_perception_snapshots"."evaluation_generation" >= 1)
);
--> statement-breakpoint
ALTER TABLE "cognitive_sessions" ADD COLUMN "evaluation_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "candidate_actions" ADD COLUMN "evaluation_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "reward_events" ADD COLUMN "skill_key" varchar(256);--> statement-breakpoint
ALTER TABLE "authoritative_perception_snapshots" ADD CONSTRAINT "authoritative_perception_snapshots_session_id_cognitive_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cognitive_sessions"("session_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authoritative_perception_snapshots" ADD CONSTRAINT "authoritative_perception_snapshots_cue_id_cues_cue_id_fk" FOREIGN KEY ("cue_id") REFERENCES "public"."cues"("cue_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "perception_snapshots_session_idx" ON "authoritative_perception_snapshots" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "candidate_actions_session_generation_idx" ON "candidate_actions" USING btree ("session_id","evaluation_generation");--> statement-breakpoint
CREATE INDEX "reward_events_skill_key_idx" ON "reward_events" USING btree ("skill_key");--> statement-breakpoint
ALTER TABLE "cognitive_sessions" ADD CONSTRAINT "cognitive_sessions_evaluation_generation_positive" CHECK ("cognitive_sessions"."evaluation_generation" >= 1);--> statement-breakpoint
ALTER TABLE "candidate_actions" ADD CONSTRAINT "candidate_actions_evaluation_generation_positive" CHECK ("candidate_actions"."evaluation_generation" >= 1);