ALTER TABLE `organization_domains` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `organization_domains` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `permissions` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `permissions` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `roles` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `roles` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `directories` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `directories` ADD `deleted_at` integer;