CREATE TABLE `scim_target_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`org_id` text NOT NULL,
	`target_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`local_resource_id` text NOT NULL,
	`external_id` text NOT NULL,
	`downstream_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_synced_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_target_resources_local_unq` ON `scim_target_resources` (`tenant_id`,`target_id`,`resource_type`,`local_resource_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_target_resources_downstream_unq` ON `scim_target_resources` (`tenant_id`,`target_id`,`resource_type`,`downstream_id`);--> statement-breakpoint
CREATE INDEX `scim_target_resources_tenant_org_target_status_id_idx` ON `scim_target_resources` (`tenant_id`,`org_id`,`target_id`,`status`,`id`);