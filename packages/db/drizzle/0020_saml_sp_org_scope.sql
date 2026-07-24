ALTER TABLE `saml_service_providers` ADD `org_id` text;
--> statement-breakpoint
UPDATE `saml_service_providers` SET `org_id` = `tenant_id` WHERE `org_id` IS NULL;
--> statement-breakpoint
CREATE INDEX `saml_service_providers_org_idx` ON `saml_service_providers` (`tenant_id`,`org_id`);
--> statement-breakpoint
DROP INDEX `saml_service_providers_entity_unq`;
--> statement-breakpoint
CREATE UNIQUE INDEX `saml_service_providers_entity_unq` ON `saml_service_providers` (`tenant_id`,`org_id`,`sp_entity_id`);