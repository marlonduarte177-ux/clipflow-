CREATE TABLE "billing_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "provider_customer_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "price_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "provider_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;