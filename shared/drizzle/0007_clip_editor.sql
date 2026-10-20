ALTER TABLE "clips" ADD COLUMN "clean_s3_key" text;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "edit_data_s3_key" text;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "edited_s3_key" text;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "edit" jsonb;