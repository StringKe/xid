UPDATE `cert_store`
SET `status` = 'retiring',
    `updated_at` = unixepoch() * 1000
WHERE `status` = 'expiring'
  AND `usage` = 'saml_idp_signing';--> statement-breakpoint
UPDATE `cert_store`
SET `status` = 'active',
    `updated_at` = unixepoch() * 1000
WHERE `status` = 'expiring'
  AND `usage` IN ('saml_sp_signing', 'saml_sp_encryption');--> statement-breakpoint
UPDATE `cert_store`
SET `status` = 'retiring',
    `updated_at` = unixepoch() * 1000
WHERE `status` = 'active'
  AND `usage` = 'saml_idp_signing'
  AND EXISTS (
    SELECT 1
    FROM `cert_store` AS `retained`
    WHERE `retained`.`tenant_id` = `cert_store`.`tenant_id`
      AND `retained`.`usage` = `cert_store`.`usage`
      AND `retained`.`status` = 'active'
      AND `retained`.`id` < `cert_store`.`id`
  );--> statement-breakpoint
CREATE UNIQUE INDEX `cert_store_tenant_usage_active_unq` ON `cert_store` (`tenant_id`,`usage`) WHERE "cert_store"."status" = 'active' AND "cert_store"."usage" = 'saml_idp_signing';
