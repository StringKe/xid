CREATE TABLE `instance_signing_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`kid` text NOT NULL,
	`alg` text DEFAULT 'ES256' NOT NULL,
	`public_key_jwk` text NOT NULL,
	`private_key_iv` blob NOT NULL,
	`private_key_ciphertext` blob NOT NULL,
	`private_key_tag` blob NOT NULL,
	`kek_version` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`activated_at` integer,
	`retire_after` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instance_signing_keys_instance_kid_unq` ON `instance_signing_keys` (`instance_id`,`kid`);--> statement-breakpoint
CREATE INDEX `instance_signing_keys_instance_status_idx` ON `instance_signing_keys` (`instance_id`,`status`);--> statement-breakpoint
INSERT INTO `instance_signing_keys` (
	`id`,
	`instance_id`,
	`kid`,
	`alg`,
	`public_key_jwk`,
	`private_key_iv`,
	`private_key_ciphertext`,
	`private_key_tag`,
	`kek_version`,
	`status`,
	`activated_at`,
	`retire_after`,
	`created_at`,
	`updated_at`
)
SELECT
	`tenant_signing_keys`.`id`,
	`organizations`.`instance_id`,
	`tenant_signing_keys`.`kid`,
	`tenant_signing_keys`.`alg`,
	`tenant_signing_keys`.`public_key_jwk`,
	`tenant_signing_keys`.`private_key_iv`,
	`tenant_signing_keys`.`private_key_ciphertext`,
	`tenant_signing_keys`.`private_key_tag`,
	`tenant_signing_keys`.`kek_version`,
	`tenant_signing_keys`.`status`,
	`tenant_signing_keys`.`activated_at`,
	`tenant_signing_keys`.`retire_after`,
	`tenant_signing_keys`.`created_at`,
	`tenant_signing_keys`.`updated_at`
FROM `tenant_signing_keys`
JOIN `organizations` ON `organizations`.`id` = `tenant_signing_keys`.`tenant_id`
WHERE `organizations`.`slug` = 'admin'
  AND `organizations`.`parent_org_id` IS NULL
  AND `organizations`.`status` = 'active'
  AND `tenant_signing_keys`.`status` IN ('active', 'next', 'retiring')
  AND NOT EXISTS (
    SELECT 1 FROM `instance_signing_keys` `existing`
    WHERE `existing`.`instance_id` = `organizations`.`instance_id`
      AND `existing`.`kid` = `tenant_signing_keys`.`kid`
  );
