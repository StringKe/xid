ALTER TABLE `refresh_tokens` ADD `family_revoked_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `instance_signing_keys_instance_next_unq` ON `instance_signing_keys` (`instance_id`) WHERE `status` = 'next';--> statement-breakpoint
ALTER TABLE `webhook_deliveries` ADD `delivery_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_delivery_key_unq` ON `webhook_deliveries` (`delivery_key`) WHERE `delivery_key` IS NOT NULL;
