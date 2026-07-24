ALTER TABLE `authorization_codes` ADD `replay_detected_at` integer;--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD `authorization_code` text;--> statement-breakpoint
CREATE INDEX `refresh_tokens_tenant_authorization_code_idx` ON `refresh_tokens` (`tenant_id`, `authorization_code`);
