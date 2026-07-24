CREATE TABLE `audit_dead_letters` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`tenant_id` text,
	`reason` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`body` text,
	`failed_at` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_dead_letters_tenant_idx` ON `audit_dead_letters` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `audit_dead_letters_failed_at_idx` ON `audit_dead_letters` (`failed_at`);