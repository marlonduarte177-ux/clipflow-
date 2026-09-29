CREATE TYPE "public"."aspect_ratio" AS ENUM('9:16', '1:1', '16:9', 'original');--> statement-breakpoint
CREATE TYPE "public"."clip_status" AS ENUM('generated', 'approved', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."export_status" AS ENUM('queued', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_stage" AS ENUM('preparing', 'analyzing', 'detecting_moments', 'rendering_clips', 'finalizing');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'processing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('analyze_video', 'render_clip', 'export_clip');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('purchase', 'subscription', 'processing', 'refund', 'bonus', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'canceled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."subtitle_format" AS ENUM('srt', 'vtt', 'json');--> statement-breakpoint
CREATE TYPE "public"."usage_metric" AS ENUM('video_seconds_uploaded', 'video_seconds_processed', 'processing_seconds', 'storage_bytes', 'clips_generated', 'ai_audio_seconds', 'ai_input_tokens', 'ai_output_tokens');--> statement-breakpoint
CREATE TYPE "public"."video_status" AS ENUM('pending_upload', 'uploaded', 'ready', 'rejected', 'deleted');--> statement-breakpoint
CREATE TABLE "clips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"video_id" uuid NOT NULL,
	"job_id" uuid,
	"status" "clip_status" DEFAULT 'generated' NOT NULL,
	"title" text,
	"start_seconds" numeric(10, 3) NOT NULL,
	"end_seconds" numeric(10, 3) NOT NULL,
	"aspect_ratio" "aspect_ratio" DEFAULT '9:16' NOT NULL,
	"score" numeric(5, 4),
	"score_breakdown" jsonb,
	"s3_key" text,
	"thumbnail_s3_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clips_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "clips_time_range" CHECK ("clips"."start_seconds" >= 0 and "clips"."end_seconds" > "clips"."start_seconds"),
	CONSTRAINT "clips_score_range" CHECK ("clips"."score" is null or ("clips"."score" >= 0 and "clips"."score" <= 1))
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"type" "ledger_entry_type" NOT NULL,
	"reference_type" text,
	"reference_id" text,
	"idempotency_key" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_ledger_seq_unique" UNIQUE("seq"),
	CONSTRAINT "credit_ledger_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "ledger_amount_nonzero" CHECK ("credit_ledger"."amount" <> 0),
	CONSTRAINT "ledger_balance_nonneg" CHECK ("credit_ledger"."balance_after" >= 0)
);
--> statement-breakpoint
CREATE TABLE "exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"clip_id" uuid NOT NULL,
	"job_id" uuid,
	"status" "export_status" DEFAULT 'queued' NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"s3_key" text,
	"size_bytes" bigint,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"video_id" uuid NOT NULL,
	"type" "job_type" NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"stage" "job_stage",
	"progress" smallint DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"locked_by" text,
	"heartbeat_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"cancel_requested_at" timestamp with time zone,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processing_jobs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "jobs_progress_range" CHECK ("processing_jobs"."progress" between 0 and 100),
	CONSTRAINT "jobs_attempts_range" CHECK ("processing_jobs"."attempts" >= 0 and "processing_jobs"."attempts" <= "processing_jobs"."max_attempts")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "projects_name_len" CHECK (char_length("projects"."name") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_code" text NOT NULL,
	"status" "subscription_status" NOT NULL,
	"provider" text,
	"provider_subscription_id" text,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subtitles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"video_id" uuid NOT NULL,
	"clip_id" uuid,
	"format" "subtitle_format" NOT NULL,
	"language" text,
	"s3_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" uuid,
	"video_id" uuid,
	"metric" "usage_metric" NOT NULL,
	"quantity" numeric(20, 6) NOT NULL,
	"estimated_cost_usd" numeric(14, 6),
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_quantity_nonneg" CHECK ("usage"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cognito_sub" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_cognito_sub_unique" UNIQUE("cognito_sub")
);
--> statement-breakpoint
CREATE TABLE "videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"status" "video_status" DEFAULT 'pending_upload' NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"duration_seconds" numeric(10, 3),
	"declared_duration_seconds" numeric(10, 3),
	"width" integer,
	"height" integer,
	"s3_key" text NOT NULL,
	"s3_upload_id" text,
	"probe" jsonb,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_at" timestamp with time zone,
	CONSTRAINT "videos_s3_key_unique" UNIQUE("s3_key"),
	CONSTRAINT "videos_id_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "videos_size_positive" CHECK ("videos"."size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_job_id_processing_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."processing_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_video_owner_fk" FOREIGN KEY ("video_id","user_id") REFERENCES "public"."videos"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_job_id_processing_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."processing_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_clip_owner_fk" FOREIGN KEY ("clip_id","user_id") REFERENCES "public"."clips"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "jobs_video_owner_fk" FOREIGN KEY ("video_id","user_id") REFERENCES "public"."videos"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtitles" ADD CONSTRAINT "subtitles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtitles" ADD CONSTRAINT "subtitles_clip_owner_fk" FOREIGN KEY ("clip_id","user_id") REFERENCES "public"."clips"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtitles" ADD CONSTRAINT "subtitles_video_owner_fk" FOREIGN KEY ("video_id","user_id") REFERENCES "public"."videos"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_job_id_processing_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."processing_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_project_owner_fk" FOREIGN KEY ("project_id","user_id") REFERENCES "public"."projects"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clips_user_idx" ON "clips" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "clips_video_idx" ON "clips" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "ledger_user_seq_idx" ON "credit_ledger" USING btree ("user_id","seq");--> statement-breakpoint
CREATE INDEX "exports_user_idx" ON "exports" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "exports_clip_idx" ON "exports" USING btree ("clip_id");--> statement-breakpoint
CREATE INDEX "jobs_user_idx" ON "processing_jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_video_idx" ON "processing_jobs" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "processing_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "projects_user_idx" ON "projects" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "subscriptions_user_idx" ON "subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_provider_uq" ON "subscriptions" USING btree ("provider","provider_subscription_id") WHERE "subscriptions"."provider" is not null;--> statement-breakpoint
CREATE INDEX "subtitles_video_idx" ON "subtitles" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "subtitles_clip_idx" ON "subtitles" USING btree ("clip_id");--> statement-breakpoint
CREATE INDEX "usage_user_idx" ON "usage" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_job_idx" ON "usage" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "videos_user_idx" ON "videos" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "videos_project_idx" ON "videos" USING btree ("project_id");