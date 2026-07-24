CREATE TABLE `scim_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`org_id` text NOT NULL,
	`provider` text NOT NULL,
	`base_url` text NOT NULL,
	`token_secret_ref` text NOT NULL,
	`user_filter` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_sync_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scim_targets_tenant_org_idx` ON `scim_targets` (`tenant_id`,`org_id`);--> statement-breakpoint
CREATE INDEX `scim_targets_tenant_status_idx` ON `scim_targets` (`tenant_id`,`status`);
