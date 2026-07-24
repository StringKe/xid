CREATE TABLE `metering_outbox` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `user_id` text NOT NULL,
  `day` text NOT NULL,
  `occurred_at` integer NOT NULL,
  `attempt_count` integer NOT NULL DEFAULT 0,
  `last_error_code` text,
  `delivered_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metering_outbox_tenant_user_day_unq` ON `metering_outbox` (`tenant_id`,`user_id`,`day`);
--> statement-breakpoint
CREATE INDEX `metering_outbox_recovery_idx` ON `metering_outbox` (`delivered_at`,`created_at`);
