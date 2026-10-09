ALTER TABLE `manager_assignments` ADD `granted_by` text;--> statement-breakpoint
ALTER TABLE `organization_domains` ADD `last_checked_at` integer;--> statement-breakpoint
ALTER TABLE `organization_domains` ADD `last_check_result` text;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `created_by` text;--> statement-breakpoint
ALTER TABLE `compliance_documents` ADD `size_bytes` integer;--> statement-breakpoint
ALTER TABLE `compliance_documents` ADD `last_checked_at` integer;--> statement-breakpoint
ALTER TABLE `compliance_documents` ADD `last_check_result` text;--> statement-breakpoint
ALTER TABLE `status_incidents` ADD `components` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `webhook_deliveries` ADD `response_ms` integer;--> statement-breakpoint
ALTER TABLE `webhook_deliveries` ADD `last_error` text;--> statement-breakpoint
CREATE INDEX `webhook_deliveries_tenant_webhook_created_id_idx` ON `webhook_deliveries` (`tenant_id`,`webhook_id`,`created_at`,`id`);