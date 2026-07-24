ALTER TABLE `notification_delivery_outbox` ADD `source_message_id` text;
--> statement-breakpoint
ALTER TABLE `notification_delivery_outbox` ADD `delivery_identity` text;
--> statement-breakpoint
ALTER TABLE `notification_delivery_outbox` ADD `failure_kind` text;
--> statement-breakpoint
ALTER TABLE `notification_delivery_outbox` ADD `failed_at` integer;
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_delivery_outbox_tenant_delivery_identity_unq` ON `notification_delivery_outbox` (`tenant_id`,`delivery_identity`) WHERE `delivery_identity` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `notification_delivery_outbox_failure_idx` ON `notification_delivery_outbox` (`status`,`failure_kind`,`failed_at`);
--> statement-breakpoint
CREATE TABLE `notification_delivery_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`channel` text NOT NULL,
	`source_message_id` text NOT NULL,
	`delivery_identity` text NOT NULL,
	`provider` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text NOT NULL,
	`attempt_count` integer NOT NULL,
	`failed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_delivery_failures_tenant_identity_unq` ON `notification_delivery_failures` (`tenant_id`,`delivery_identity`);
--> statement-breakpoint
CREATE INDEX `notification_delivery_failures_tenant_outcome_idx` ON `notification_delivery_failures` (`tenant_id`,`outcome`,`failed_at`);
--> statement-breakpoint
CREATE INDEX `notification_delivery_failures_channel_source_idx` ON `notification_delivery_failures` (`channel`,`source_message_id`);
