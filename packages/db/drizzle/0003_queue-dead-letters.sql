CREATE TABLE `queue_dead_letters` (
	`id` text PRIMARY KEY NOT NULL,
	`source_queue` text NOT NULL,
	`dead_letter_queue` text NOT NULL,
	`message_id` text NOT NULL,
	`tenant_id` text,
	`org_id` text,
	`event_type` text DEFAULT 'unknown' NOT NULL,
	`error_code` text DEFAULT 'consumer_retries_exhausted' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`payload_iv` text NOT NULL,
	`payload_ciphertext` text NOT NULL,
	`payload_tag` text NOT NULL,
	`payload_kek_version` integer DEFAULT 1 NOT NULL,
	`source_enqueued_at` integer NOT NULL,
	`failed_at` integer NOT NULL,
	`replay_requested_at` integer,
	`replayed_at` integer,
	`replayed_by` text,
	`replay_count` integer DEFAULT 0 NOT NULL,
	`last_replay_error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `queue_dead_letters_source_message_unq` ON `queue_dead_letters` (`source_queue`,`message_id`);--> statement-breakpoint
CREATE INDEX `queue_dead_letters_status_failed_id_idx` ON `queue_dead_letters` (`status`,`failed_at`,`id`);--> statement-breakpoint
CREATE INDEX `queue_dead_letters_tenant_failed_id_idx` ON `queue_dead_letters` (`tenant_id`,`failed_at`,`id`);--> statement-breakpoint
CREATE INDEX `queue_dead_letters_source_status_idx` ON `queue_dead_letters` (`source_queue`,`status`);