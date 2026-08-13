CREATE TABLE `magic_link_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`flow_context` text NOT NULL,
	`consumed_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `magic_link_tokens_hash_unq` ON `magic_link_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `magic_link_tokens_tenant_user_expiry_idx` ON `magic_link_tokens` (`tenant_id`,`user_id`,`expires_at`);
