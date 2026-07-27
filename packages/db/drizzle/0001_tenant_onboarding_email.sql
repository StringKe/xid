ALTER TABLE `users` ADD `pending_email` text;--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_instance_slug_unq` ON `organizations` (`instance_id`,`slug`);