CREATE TABLE `billing_subscriptions` (
	`subscription_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`status` text NOT NULL,
	`last_event_id` text NOT NULL,
	`last_event_created` integer NOT NULL,
	`last_event_priority` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `billing_subscriptions_tenant_status_idx` ON `billing_subscriptions` (`tenant_id`,`status`);--> statement-breakpoint
ALTER TABLE `billing_meter_reports` ADD `pending_sent_at` integer;--> statement-breakpoint
UPDATE `billing_meter_reports` SET `pending_sent_at` = `pending_reserved_at` WHERE `pending_identifier` IS NOT NULL AND `provider_accepted_at` IS NULL;
