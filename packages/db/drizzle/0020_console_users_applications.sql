ALTER TABLE `applications` ADD `name` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `logo_uri` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `application_type` text;--> statement-breakpoint
CREATE INDEX `users_tenant_last_login_idx` ON `users` (`tenant_id`,`last_login_at`);--> statement-breakpoint
CREATE INDEX `audit_events_tenant_actor_occurred_idx` ON `audit_events` (`tenant_id`,`actor_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `audit_events_tenant_target_occurred_idx` ON `audit_events` (`tenant_id`,`target_id`,`occurred_at`);