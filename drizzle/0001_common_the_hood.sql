CREATE TABLE "package_destinations" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(120) NOT NULL,
	"title_en" varchar(190) NOT NULL,
	"title_ar" varchar(190) DEFAULT '' NOT NULL,
	"summary_en" text DEFAULT '' NOT NULL,
	"summary_ar" text DEFAULT '' NOT NULL,
	"image_id" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_published" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_destinations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "travel_packages" ADD COLUMN "destination_id" integer;--> statement-breakpoint
ALTER TABLE "package_destinations" ADD CONSTRAINT "package_destinations_image_id_media_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_packages" ADD CONSTRAINT "travel_packages_destination_id_package_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."package_destinations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "travel_packages_destination_idx" ON "travel_packages" USING btree ("destination_id","sort_order");