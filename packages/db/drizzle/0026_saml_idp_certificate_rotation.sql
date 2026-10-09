ALTER TABLE `sso_connections` ADD `idp_metadata_xml` text;--> statement-breakpoint
ALTER TABLE `sso_connections` ADD `idp_metadata_refreshed_at` integer;--> statement-breakpoint
ALTER TABLE `sso_connections` ADD `idp_metadata_last_error` text;--> statement-breakpoint
ALTER TABLE `sso_connections` ADD `idp_metadata_last_error_at` integer;--> statement-breakpoint
ALTER TABLE `cert_store` ADD `retire_after` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `cert_store_tenant_usage_next_unq` ON `cert_store` (`tenant_id`,`usage`) WHERE "cert_store"."status" = 'next' AND "cert_store"."usage" = 'saml_idp_signing';
