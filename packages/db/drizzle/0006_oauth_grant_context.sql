ALTER TABLE `authorization_codes` ADD `active_org_id` text;--> statement-breakpoint
ALTER TABLE `authorization_codes` ADD `project_grant_id` text;--> statement-breakpoint
CREATE INDEX `authorization_codes_active_org_idx` ON `authorization_codes` (`active_org_id`);--> statement-breakpoint
CREATE INDEX `authorization_codes_project_grant_idx` ON `authorization_codes` (`project_grant_id`);--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD `active_org_id` text;--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD `project_grant_id` text;--> statement-breakpoint
CREATE INDEX `refresh_tokens_active_org_idx` ON `refresh_tokens` (`active_org_id`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_project_grant_idx` ON `refresh_tokens` (`project_grant_id`);