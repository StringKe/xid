CREATE TABLE `notification_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`channel` text NOT NULL,
	`recipient` text NOT NULL,
	`type` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`provider` text,
	`reason` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`failed_at` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_failures_tenant_idx` ON `notification_failures` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `notification_failures_channel_type_idx` ON `notification_failures` (`channel`,`type`);--> statement-breakpoint
CREATE INDEX `notification_failures_failed_at_idx` ON `notification_failures` (`failed_at`);--> statement-breakpoint
ALTER TABLE `webhooks` ADD `signing_secret_iv` text;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `signing_secret_ciphertext` text;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `signing_secret_tag` text;