ALTER TABLE `user_identities` ADD `revoked_at` integer;--> statement-breakpoint
ALTER TABLE `passkey_credentials` ADD `revoked_at` integer;