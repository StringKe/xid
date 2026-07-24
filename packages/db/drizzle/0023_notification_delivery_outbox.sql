CREATE TABLE `notification_delivery_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`delivery_key` text NOT NULL,
	`channel` text NOT NULL,
	`type` text NOT NULL,
	`provider` text,
	`recipient_hash` text NOT NULL,
	`recipient_iv` text NOT NULL,
	`recipient_ciphertext` text NOT NULL,
	`recipient_tag` text NOT NULL,
	`payload_iv` text NOT NULL,
	`payload_ciphertext` text NOT NULL,
	`payload_tag` text NOT NULL,
	`status` text NOT NULL DEFAULT 'pending',
	`attempt_count` integer NOT NULL DEFAULT 0,
	`available_at` integer NOT NULL,
	`lease_until` integer,
	`last_error_code` text,
	`provider_accepted_at` integer,
	`audit_queued_at` integer,
	`queued_at` integer,
	`delivered_at` integer,
	`dead_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_delivery_outbox_tenant_delivery_key_unq` ON `notification_delivery_outbox` (`tenant_id`,`delivery_key`);
--> statement-breakpoint
CREATE INDEX `notification_delivery_outbox_tenant_ready_idx` ON `notification_delivery_outbox` (`tenant_id`,`status`,`available_at`);
--> statement-breakpoint
CREATE INDEX `notification_delivery_outbox_dispatch_idx` ON `notification_delivery_outbox` (`status`,`available_at`,`lease_until`);
