CREATE TABLE "route_nodes" (
	"owner_key" varchar(64) PRIMARY KEY NOT NULL,
	"route_key" varchar(64) NOT NULL,
	"styles" jsonb,
	"motion" jsonb,
	"copy" jsonb,
	"draft_content" jsonb,
	"draft_styles" jsonb,
	"draft_motion" jsonb,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" integer,
	"updated_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "route_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"route_key" varchar(64) NOT NULL,
	"kind" varchar(16) DEFAULT 'publish' NOT NULL,
	"summary" varchar(255) DEFAULT '' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" integer,
	"actor_name" varchar(120) DEFAULT 'System' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_categories" ADD COLUMN "cta_href" varchar(255) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "route_nodes" ADD CONSTRAINT "route_nodes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_nodes" ADD CONSTRAINT "route_nodes_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_versions" ADD CONSTRAINT "route_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "route_nodes_route_idx" ON "route_nodes" USING btree ("route_key");--> statement-breakpoint
CREATE INDEX "route_versions_route_idx" ON "route_versions" USING btree ("route_key","created_at");