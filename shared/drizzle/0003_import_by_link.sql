ALTER TYPE "public"."job_stage" ADD VALUE 'downloading' BEFORE 'preparing';--> statement-breakpoint
ALTER TYPE "public"."video_status" ADD VALUE 'importing' BEFORE 'uploaded';--> statement-breakpoint
ALTER TABLE "videos" DROP CONSTRAINT "videos_size_positive";--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "rights_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_size_positive" CHECK ("videos"."size_bytes" > 0 or "videos"."status"::text in ('importing', 'rejected'));