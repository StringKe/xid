DROP INDEX IF EXISTS `directory_users_dir_username_unq`;--> statement-breakpoint
CREATE UNIQUE INDEX `directory_users_dir_username_unq` ON `directory_users` (`directory_id`,`user_name`) WHERE "directory_users"."status" <> 'deleted' AND "directory_users"."deleted_at" IS NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `directory_users_dir_external_unq`;--> statement-breakpoint
CREATE UNIQUE INDEX `directory_users_dir_external_unq` ON `directory_users` (`directory_id`,`external_id`) WHERE "directory_users"."status" <> 'deleted' AND "directory_users"."deleted_at" IS NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `directory_groups_dir_name_unq`;--> statement-breakpoint
CREATE UNIQUE INDEX `directory_groups_dir_name_unq` ON `directory_groups` (`directory_id`,`display_name`) WHERE "directory_groups"."status" <> 'deleted' AND "directory_groups"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE `scim_targets` ADD `full_sync_queued_at` integer;
