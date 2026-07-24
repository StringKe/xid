CREATE TABLE `access_token_issuances` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `jti` text NOT NULL,
  `client_id` text NOT NULL,
  `subject` text NOT NULL,
  `authorization_code` text,
  `refresh_family_id` text,
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_token_issuances_tenant_jti_unq` ON `access_token_issuances` (`tenant_id`,`jti`);
--> statement-breakpoint
CREATE INDEX `access_token_issuances_tenant_code_idx` ON `access_token_issuances` (`tenant_id`,`authorization_code`);
--> statement-breakpoint
CREATE INDEX `access_token_issuances_tenant_family_idx` ON `access_token_issuances` (`tenant_id`,`refresh_family_id`);
--> statement-breakpoint
CREATE INDEX `access_token_issuances_expires_idx` ON `access_token_issuances` (`expires_at`);
