CREATE TABLE `saml_persistent_name_ids` (
	`tenant_id` text NOT NULL,
	`sp_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `sp_id`, `user_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saml_persistent_name_ids_name_unq` ON `saml_persistent_name_ids` (`tenant_id`,`sp_id`,`name_id`);
