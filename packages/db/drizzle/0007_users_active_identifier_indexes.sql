DROP INDEX `users_tenant_username_unq`;--> statement-breakpoint
DROP INDEX `users_tenant_external_id_unq`;--> statement-breakpoint
CREATE UNIQUE INDEX `users_tenant_username_unq` ON `users` (`tenant_id`,`username`) WHERE `deleted_at` IS NULL AND `status` <> 'deleted';--> statement-breakpoint
CREATE UNIQUE INDEX `users_tenant_external_id_unq` ON `users` (`tenant_id`,`external_id`) WHERE `deleted_at` IS NULL AND `status` <> 'deleted';--> statement-breakpoint
