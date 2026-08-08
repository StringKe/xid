CREATE TABLE `org_unit_members` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`org_id` text NOT NULL,
	`unit_id` text NOT NULL,
	`user_id` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_unit_members_unq` ON `org_unit_members` (`unit_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `org_unit_members_primary_unq` ON `org_unit_members` (`tenant_id`,`org_id`,`user_id`) WHERE "org_unit_members"."is_primary" = 1;--> statement-breakpoint
CREATE INDEX `org_unit_members_tenant_user_idx` ON `org_unit_members` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `org_unit_members_tenant_org_user_idx` ON `org_unit_members` (`tenant_id`,`org_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `org_unit_members_unit_idx` ON `org_unit_members` (`tenant_id`,`unit_id`);--> statement-breakpoint
CREATE TABLE `org_units` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`org_id` text NOT NULL,
	`parent_unit_id` text,
	`path` text NOT NULL,
	`depth` integer NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`manager_user_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_units_tenant_org_parent_slug_unq` ON `org_units` (`tenant_id`,`org_id`,`parent_unit_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `org_units_tenant_path_unq` ON `org_units` (`tenant_id`,`path`);--> statement-breakpoint
CREATE INDEX `org_units_tenant_org_idx` ON `org_units` (`tenant_id`,`org_id`);--> statement-breakpoint
CREATE INDEX `org_units_tenant_org_parent_idx` ON `org_units` (`tenant_id`,`org_id`,`parent_unit_id`);--> statement-breakpoint
CREATE INDEX `org_units_tenant_path_idx` ON `org_units` (`tenant_id`,`path`);--> statement-breakpoint
CREATE INDEX `org_units_manager_idx` ON `org_units` (`tenant_id`,`manager_user_id`);