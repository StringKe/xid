CREATE TABLE `custom_hostnames` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`org_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`hostname` text NOT NULL,
	`cloudflare_hostname_id` text,
	`status` text DEFAULT 'provisioning' NOT NULL,
	`hostname_status` text DEFAULT 'pending' NOT NULL,
	`ssl_status` text,
	`ownership_verification_type` text,
	`ownership_verification_name` text,
	`ownership_verification_value` text,
	`ownership_expires_at` integer,
	`dcv_delegation_records` text DEFAULT '[]' NOT NULL,
	`validation_records` text DEFAULT '[]' NOT NULL,
	`traffic_cname_target` text NOT NULL,
	`verification_errors` text DEFAULT '[]' NOT NULL,
	`requires_passkey_reregistration` integer DEFAULT true NOT NULL,
	`activated_at` integer,
	`last_polled_at` integer,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_hostnames_hostname_unq` ON `custom_hostnames` (`hostname`);--> statement-breakpoint
CREATE UNIQUE INDEX `custom_hostnames_cloudflare_id_unq` ON `custom_hostnames` (`cloudflare_hostname_id`);--> statement-breakpoint
CREATE INDEX `custom_hostnames_tenant_org_status_id_idx` ON `custom_hostnames` (`tenant_id`,`org_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `custom_hostnames_status_expiry_id_idx` ON `custom_hostnames` (`status`,`ownership_expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `custom_hostnames_instance_status_id_idx` ON `custom_hostnames` (`instance_id`,`status`,`id`);