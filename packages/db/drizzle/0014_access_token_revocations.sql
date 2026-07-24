CREATE TABLE `access_token_revocations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`jti` text NOT NULL,
	`client_id` text NOT NULL,
	`subject` text,
	`expires_at` integer NOT NULL,
	`revoked_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_token_revocations_tenant_jti_unq` ON `access_token_revocations` (`tenant_id`,`jti`);--> statement-breakpoint
CREATE INDEX `access_token_revocations_tenant_client_idx` ON `access_token_revocations` (`tenant_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `access_token_revocations_expires_idx` ON `access_token_revocations` (`expires_at`);