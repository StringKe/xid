ALTER TABLE `directory_groups` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `directory_groups` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `directory_users` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `directory_users` ADD `deleted_at` integer;