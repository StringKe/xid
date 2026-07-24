ALTER TABLE `notification_failures` ADD `source_message_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_failures_source_message_id_unq` ON `notification_failures` (`source_message_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_dead_letters_message_id_unq` ON `audit_dead_letters` (`message_id`);
