CREATE TABLE `swa_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`org_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`user_id` text NOT NULL,
	`secret_iv` text NOT NULL,
	`secret_ciphertext` text NOT NULL,
	`secret_tag` text NOT NULL,
	`kek_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `swa_credentials_tenant_connection_user_unq` ON `swa_credentials` (`tenant_id`,`connection_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `swa_credentials_tenant_user_idx` ON `swa_credentials` (`tenant_id`,`user_id`);
