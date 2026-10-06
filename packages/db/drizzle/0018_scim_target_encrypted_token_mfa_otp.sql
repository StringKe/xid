ALTER TABLE `scim_targets` ADD `token_iv` text;--> statement-breakpoint
ALTER TABLE `scim_targets` ADD `token_ciphertext` text;--> statement-breakpoint
ALTER TABLE `scim_targets` ADD `token_tag` text;--> statement-breakpoint
ALTER TABLE `scim_targets` ADD `last_run_status` text;--> statement-breakpoint
ALTER TABLE `scim_targets` ADD `last_run_error` text;--> statement-breakpoint
ALTER TABLE `scim_targets` ADD `last_run_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `verification_tokens_active_mfa_otp_unq` ON `verification_tokens` (`tenant_id`, `user_id`, `purpose`, COALESCE(`channel`, '')) WHERE `consumed_at` IS NULL AND `purpose` = 'mfa_otp';