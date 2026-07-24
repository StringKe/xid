ALTER TABLE `sso_connections` ADD `idp_slo_url` text;--> statement-breakpoint
ALTER TABLE `saml_service_providers` ADD `slo_binding` text DEFAULT 'redirect' NOT NULL;--> statement-breakpoint
ALTER TABLE `saml_service_providers` ADD `sp_certificates` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE TABLE `saml_session_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`direction` text NOT NULL,
	`scope_id` text NOT NULL,
	`session_index` text NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`name_id` text,
	`name_id_format` text,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saml_session_bindings_lookup_unq` ON `saml_session_bindings` (`tenant_id`,`direction`,`scope_id`,`session_index`);--> statement-breakpoint
CREATE INDEX `saml_session_bindings_user_session_idx` ON `saml_session_bindings` (`tenant_id`,`user_id`,`session_id`,`direction`);--> statement-breakpoint
CREATE INDEX `saml_session_bindings_name_idx` ON `saml_session_bindings` (`tenant_id`,`direction`,`scope_id`,`name_id`);