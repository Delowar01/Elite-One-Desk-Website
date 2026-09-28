CREATE TABLE "reusable_component_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"component_id" integer NOT NULL,
	"version" integer NOT NULL,
	"values" jsonb NOT NULL,
	"label" varchar(120) DEFAULT '' NOT NULL,
	"created_by" integer,
	"actor_name" varchar(120) DEFAULT 'System' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reusable_components" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" varchar(48) NOT NULL,
	"name" varchar(120) NOT NULL,
	"published" jsonb,
	"draft" jsonb,
	"published_version" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_by" integer,
	"updated_by" integer,
	"published_by" integer,
	"published_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reusable_component_versions" ADD CONSTRAINT "reusable_component_versions_component_id_reusable_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."reusable_components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reusable_component_versions" ADD CONSTRAINT "reusable_component_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reusable_components" ADD CONSTRAINT "reusable_components_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reusable_components" ADD CONSTRAINT "reusable_components_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reusable_components" ADD CONSTRAINT "reusable_components_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reusable_component_versions_version_idx" ON "reusable_component_versions" USING btree ("component_id","version");--> statement-breakpoint
CREATE INDEX "reusable_component_versions_component_idx" ON "reusable_component_versions" USING btree ("component_id","id");--> statement-breakpoint
CREATE INDEX "reusable_components_status_idx" ON "reusable_components" USING btree ("status","name");--> statement-breakpoint
CREATE INDEX "page_sections_reuse_idx" ON "page_sections" USING btree ("page_id") WHERE ("page_sections"."published" ? '_reuse') OR ("page_sections"."draft" ? '_reuse');