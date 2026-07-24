ALTER TABLE `audit_events` ADD `source_message_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_tenant_source_message_id_unq`
  ON `audit_events` (`tenant_id`,`source_message_id`)
  WHERE `source_message_id` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `audit_dead_letters` ADD `source_message_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_dead_letters_tenant_source_message_id_unq`
  ON `audit_dead_letters` (`tenant_id`,`source_message_id`)
  WHERE `source_message_id` IS NOT NULL;
