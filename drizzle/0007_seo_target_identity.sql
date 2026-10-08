ALTER TABLE "seo_metadata" ADD COLUMN "entity_id" integer;--> statement-breakpoint
ALTER TABLE "seo_metadata" ADD COLUMN "og_title_ar" varchar(190) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "seo_metadata" ADD COLUMN "og_description_ar" varchar(320) DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "seo_entity_id_idx" ON "seo_metadata" USING btree ("entity_type","entity_id") WHERE "seo_metadata"."entity_id" > 0;