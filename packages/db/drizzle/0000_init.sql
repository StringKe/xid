CREATE TABLE `applications` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text,
	`client_id` text NOT NULL,
	`client_secret_hash` text,
	`client_type` text DEFAULT 'confidential' NOT NULL,
	`token_endpoint_auth_method` text DEFAULT 'client_secret_basic' NOT NULL,
	`jwks` text,
	`redirect_uris` text DEFAULT '[]' NOT NULL,
	`post_logout_redirect_uris` text DEFAULT '[]' NOT NULL,
	`frontchannel_logout_uri` text,
	`backchannel_logout_uri` text,
	`allowed_grant_types` text DEFAULT '["authorization_code","refresh_token"]' NOT NULL,
	`allowed_response_types` text DEFAULT '["code"]' NOT NULL,
	`allowed_scopes` text DEFAULT '["openid","profile","email","offline_access"]' NOT NULL,
	`require_pkce` integer DEFAULT true NOT NULL,
	`dpop_bound_access_tokens` integer DEFAULT false NOT NULL,
	`access_token_format` text DEFAULT 'jwt' NOT NULL,
	`access_token_ttl_sec` integer,
	`id_token_signed_alg` text DEFAULT 'ES256' NOT NULL,
	`first_party` integer DEFAULT false NOT NULL,
	`require_org_context` integer DEFAULT false NOT NULL,
	`custom_claims_config` text DEFAULT '{}' NOT NULL,
	`registration_access_token_hash` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `applications_client_id_unq` ON `applications` (`client_id`);--> statement-breakpoint
CREATE INDEX `applications_tenant_project_idx` ON `applications` (`tenant_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `applications_tenant_status_id_idx` ON `applications` (`tenant_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `applications_tenant_status_idx` ON `applications` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `instances` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`primary_domain` text NOT NULL,
	`mode` text DEFAULT 'multi_tenant' NOT NULL,
	`default_locale` text DEFAULT 'en' NOT NULL,
	`data_residency` text DEFAULT 'us' NOT NULL,
	`mfa_policy` text DEFAULT 'optional' NOT NULL,
	`password_policy` text NOT NULL,
	`session_policy` text NOT NULL,
	`token_policy` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instances_primary_domain_unq` ON `instances` (`primary_domain`);--> statement-breakpoint
CREATE TABLE `org_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`org_id` text NOT NULL,
	`mfa_policy` text,
	`mfa_allowed_methods` text,
	`password_policy` text,
	`token_policy` text,
	`session_idle_timeout_min` integer,
	`session_absolute_timeout_days` integer,
	`force_sso` integer DEFAULT false NOT NULL,
	`allow_password_login` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_policies_org_unq` ON `org_policies` (`org_id`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`parent_org_id` text,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`logo_url` text,
	`public_metadata` text DEFAULT '{}' NOT NULL,
	`private_metadata` text DEFAULT '{}' NOT NULL,
	`seat_limit` integer,
	`seat_used` integer DEFAULT 0 NOT NULL,
	`enrollment_mode` text DEFAULT 'invite_required' NOT NULL,
	`allow_org_self_service` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_tenant_slug_unq` ON `organizations` (`tenant_id`,`slug`);--> statement-breakpoint
CREATE INDEX `organizations_instance_slug_idx` ON `organizations` (`instance_id`,`slug`);--> statement-breakpoint
CREATE INDEX `organizations_top_level_id_idx` ON `organizations` (`id`) WHERE "organizations"."parent_org_id" IS NULL;--> statement-breakpoint
CREATE INDEX `organizations_active_id_idx` ON `organizations` (`id`) WHERE "organizations"."status" = 'active';--> statement-breakpoint
CREATE INDEX `organizations_tenant_status_id_idx` ON `organizations` (`tenant_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `organizations_instance_idx` ON `organizations` (`instance_id`);--> statement-breakpoint
CREATE INDEX `organizations_parent_idx` ON `organizations` (`parent_org_id`);--> statement-breakpoint
CREATE INDEX `organizations_parent_id_idx` ON `organizations` (`parent_org_id`,`id`);--> statement-breakpoint
CREATE INDEX `organizations_tenant_status_idx` ON `organizations` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `project_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`granted_project_id` text NOT NULL,
	`granted_by_org_id` text NOT NULL,
	`granted_to_org_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_grants_project_org_unq` ON `project_grants` (`granted_project_id`,`granted_to_org_id`);--> statement-breakpoint
CREATE INDEX `project_grants_tenant_status_id_idx` ON `project_grants` (`tenant_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `project_grants_tenant_project_status_id_idx` ON `project_grants` (`tenant_id`,`granted_project_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `project_grants_tenant_to_org_status_id_idx` ON `project_grants` (`tenant_id`,`granted_to_org_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `project_grants_to_org_idx` ON `project_grants` (`granted_to_org_id`);--> statement-breakpoint
CREATE INDEX `project_grants_tenant_idx` ON `project_grants` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `projects_tenant_org_idx` ON `projects` (`tenant_id`,`org_id`);--> statement-breakpoint
CREATE TABLE `gdpr_consents` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`consent_type` text NOT NULL,
	`granted` integer NOT NULL,
	`source_ip` text,
	`granted_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `gdpr_consents_tenant_user_type_idx` ON `gdpr_consents` (`tenant_id`,`user_id`,`consent_type`);--> statement-breakpoint
CREATE TABLE `user_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`verification_status` text DEFAULT 'unverified' NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`verified_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_emails_tenant_email_unq` ON `user_emails` (`tenant_id`,`email`);--> statement-breakpoint
CREATE INDEX `user_emails_email_lookup_idx` ON `user_emails` (`email`,`user_id`,`tenant_id`);--> statement-breakpoint
CREATE INDEX `user_emails_user_primary_idx` ON `user_emails` (`user_id`,`is_primary`);--> statement-breakpoint
CREATE INDEX `user_emails_tenant_user_primary_created_idx` ON `user_emails` (`tenant_id`,`user_id`,`is_primary`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `user_emails_tenant_user_idx` ON `user_emails` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `user_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`identity_type` text NOT NULL,
	`provider` text,
	`provider_user_id` text,
	`access_token_ciphertext` blob,
	`refresh_token_ciphertext` blob,
	`token_expires_at` integer,
	`scopes` text,
	`profile_raw` text,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_provider_unq` ON `user_identities` (`tenant_id`,`provider`,`provider_user_id`);--> statement-breakpoint
CREATE INDEX `user_identities_tenant_user_idx` ON `user_identities` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `user_identities_tenant_user_type_active_idx` ON `user_identities` (`tenant_id`,`user_id`,`identity_type`,`id`) WHERE "user_identities"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX `user_identities_tenant_type_idx` ON `user_identities` (`tenant_id`,`identity_type`);--> statement-breakpoint
CREATE TABLE `user_phones` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`phone` text NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`verification_status` text DEFAULT 'unverified' NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`verified_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_phones_tenant_phone_unq` ON `user_phones` (`tenant_id`,`phone`);--> statement-breakpoint
CREATE INDEX `user_phones_phone_lookup_idx` ON `user_phones` (`phone`,`user_id`,`tenant_id`);--> statement-breakpoint
CREATE INDEX `user_phones_tenant_user_idx` ON `user_phones` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`username` text,
	`external_id` text,
	`primary_email_id` text,
	`primary_phone_id` text,
	`first_name` text,
	`last_name` text,
	`display_name` text,
	`avatar_url` text,
	`locale` text,
	`timezone` text,
	`public_metadata` text DEFAULT '{}' NOT NULL,
	`private_metadata` text DEFAULT '{}' NOT NULL,
	`unsafe_metadata` text DEFAULT '{}' NOT NULL,
	`custom_attributes` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`password_change_required` integer DEFAULT false NOT NULL,
	`is_new_user` integer DEFAULT true NOT NULL,
	`profile_completion_status` text DEFAULT 'incomplete' NOT NULL,
	`lockout_until` integer,
	`failed_login_count` integer DEFAULT 0 NOT NULL,
	`last_login_at` integer,
	`merged_into_user_id` text,
	`provisioned_by` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_tenant_username_unq` ON `users` (`tenant_id`,`username`) WHERE "users"."deleted_at" IS NULL AND "users"."status" <> 'deleted';--> statement-breakpoint
CREATE UNIQUE INDEX `users_tenant_external_id_unq` ON `users` (`tenant_id`,`external_id`) WHERE "users"."deleted_at" IS NULL AND "users"."status" <> 'deleted';--> statement-breakpoint
CREATE INDEX `users_username_active_lookup_idx` ON `users` (`username`,`tenant_id`) WHERE "users"."deleted_at" IS NULL AND "users"."status" = 'active';--> statement-breakpoint
CREATE INDEX `users_external_id_active_lookup_idx` ON `users` (`external_id`,`tenant_id`) WHERE "users"."deleted_at" IS NULL AND "users"."status" = 'active';--> statement-breakpoint
CREATE INDEX `users_active_cursor_idx` ON `users` (`tenant_id`,`id`) WHERE "users"."deleted_at" IS NULL AND "users"."status" <> 'deleted';--> statement-breakpoint
CREATE INDEX `users_active_global_idx` ON `users` (`id`) WHERE "users"."deleted_at" IS NULL AND "users"."status" <> 'deleted';--> statement-breakpoint
CREATE INDEX `users_tenant_status_idx` ON `users` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `users_tenant_created_idx` ON `users` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `users_primary_email_idx` ON `users` (`primary_email_id`);--> statement-breakpoint
CREATE INDEX `users_merged_into_idx` ON `users` (`merged_into_user_id`);--> statement-breakpoint
CREATE TABLE `backup_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`used` integer DEFAULT false NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `backup_codes_tenant_user_batch_idx` ON `backup_codes` (`tenant_id`,`user_id`,`batch_id`);--> statement-breakpoint
CREATE INDEX `backup_codes_tenant_user_used_idx` ON `backup_codes` (`tenant_id`,`user_id`,`used`);--> statement-breakpoint
CREATE INDEX `backup_codes_tenant_code_idx` ON `backup_codes` (`tenant_id`,`code_hash`);--> statement-breakpoint
CREATE TABLE `metering_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	`delivered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metering_outbox_tenant_user_day_unq` ON `metering_outbox` (`tenant_id`,`user_id`,`day`);--> statement-breakpoint
CREATE INDEX `metering_outbox_recovery_idx` ON `metering_outbox` (`delivered_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `mfa_factors` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`factor_type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`secret_ciphertext` blob,
	`target` text,
	`passkey_credential_id` text,
	`is_default` integer DEFAULT false NOT NULL,
	`last_used_at` integer,
	`activated_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mfa_factors_tenant_user_idx` ON `mfa_factors` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `mfa_factors_tenant_user_type_idx` ON `mfa_factors` (`tenant_id`,`user_id`,`factor_type`);--> statement-breakpoint
CREATE TABLE `passkey_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` blob NOT NULL,
	`cose_alg` integer NOT NULL,
	`aaguid` blob NOT NULL,
	`sign_count` integer DEFAULT 0 NOT NULL,
	`transports` text DEFAULT '[]' NOT NULL,
	`credential_device_type` text NOT NULL,
	`backed_up` integer DEFAULT false NOT NULL,
	`device_name` text,
	`attestation_fmt` text DEFAULT 'none' NOT NULL,
	`enterprise_attestation_verified` integer DEFAULT false NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkey_credentials_tenant_cred_unq` ON `passkey_credentials` (`tenant_id`,`credential_id`);--> statement-breakpoint
CREATE INDEX `passkey_credentials_tenant_user_idx` ON `passkey_credentials` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `passkey_credentials_tenant_user_active_idx` ON `passkey_credentials` (`tenant_id`,`user_id`,`id`) WHERE "passkey_credentials"."revoked_at" IS NULL;--> statement-breakpoint
CREATE TABLE `password_history` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`hash` text NOT NULL,
	`reuse_tag` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `password_history_tenant_user_idx` ON `password_history` (`tenant_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `password_reset_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`purpose` text DEFAULT 'password_reset' NOT NULL,
	`consumed_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `password_reset_tokens_hash_unq` ON `password_reset_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `password_reset_tokens_tenant_user_idx` ON `password_reset_tokens` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `passwords` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`hash` text NOT NULL,
	`algo` text DEFAULT 'argon2id' NOT NULL,
	`pepper_version` integer NOT NULL,
	`reuse_tag` text,
	`breached` integer DEFAULT false NOT NULL,
	`breach_checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passwords_user_unq` ON `passwords` (`user_id`);--> statement-breakpoint
CREATE TABLE `trusted_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`device_token_hash` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`device_name` text,
	`last_seen_ip` text,
	`last_seen_at` integer,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `trusted_devices_tenant_user_idx` ON `trusted_devices` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `trusted_devices_tenant_user_active_idx` ON `trusted_devices` (`tenant_id`,`user_id`,`expires_at`,`id`) WHERE "trusted_devices"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX `trusted_devices_tenant_token_idx` ON `trusted_devices` (`tenant_id`,`device_token_hash`);--> statement-breakpoint
CREATE TABLE `verification_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`code_hash` text,
	`channel` text,
	`purpose` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`consumed_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verification_tokens_hash_unq` ON `verification_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `verification_tokens_tenant_user_idx` ON `verification_tokens` (`tenant_id`,`user_id`);--> statement-breakpoint
-- 手工维护:drizzle-kit 0.31.10 无法往返序列化 credentials.ts 里的 sql`coalesce(...)` 索引表达式,
-- 它按逗号切碎再逐段反引号包裹,产出 `coalesce("channel"`,` '')` 这种非法 SQL(SQLite 报 no such column)。
-- 下面这句取自原 0027_active_verification_credential.sql,重新 generate baseline 时必须重新套用。
CREATE UNIQUE INDEX `verification_tokens_active_credential_unq` ON `verification_tokens` (`tenant_id`, `user_id`, `purpose`, COALESCE(`channel`, '')) WHERE `consumed_at` IS NULL AND `purpose` IN ('magic_link', 'otp');--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`org_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`token_hash` text NOT NULL,
	`invite_type` text DEFAULT 'email' NOT NULL,
	`max_uses` integer,
	`used_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`invited_by_user_id` text,
	`accepted_by_user_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_token_unq` ON `invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invitations_tenant_org_status_id_idx` ON `invitations` (`tenant_id`,`org_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `invitations_tenant_org_status_idx` ON `invitations` (`tenant_id`,`org_id`,`status`);--> statement-breakpoint
CREATE INDEX `invitations_tenant_email_idx` ON `invitations` (`tenant_id`,`email`);--> statement-breakpoint
CREATE TABLE `manager_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`manager_role` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `manager_assignments_unq` ON `manager_assignments` (`user_id`,`manager_role`,`scope_type`,`scope_id`);--> statement-breakpoint
CREATE INDEX `manager_assignments_tenant_user_idx` ON `manager_assignments` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `manager_assignments_scope_idx` ON `manager_assignments` (`scope_type`,`scope_id`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`membership_type` text DEFAULT 'member' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`is_managed` integer DEFAULT false NOT NULL,
	`invited_by_user_id` text,
	`joined_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_org_user_unq` ON `memberships` (`org_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `memberships_tenant_user_idx` ON `memberships` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `memberships_tenant_user_status_id_idx` ON `memberships` (`tenant_id`,`user_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `memberships_tenant_org_status_id_idx` ON `memberships` (`tenant_id`,`org_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `memberships_tenant_org_status_idx` ON `memberships` (`tenant_id`,`org_id`,`status`);--> statement-breakpoint
CREATE TABLE `organization_domains` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`org_id` text NOT NULL,
	`domain` text NOT NULL,
	`verification_method` text DEFAULT 'dns_txt' NOT NULL,
	`verification_token` text NOT NULL,
	`verification_status` text DEFAULT 'pending' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`is_wildcard` integer DEFAULT false NOT NULL,
	`enrollment_mode` text DEFAULT 'invite_required' NOT NULL,
	`verified_at` integer,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_domains_domain_unq` ON `organization_domains` (`domain`);--> statement-breakpoint
CREATE INDEX `organization_domains_tenant_org_idx` ON `organization_domains` (`tenant_id`,`org_id`);--> statement-breakpoint
CREATE INDEX `organization_domains_tenant_org_status_id_idx` ON `organization_domains` (`tenant_id`,`org_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `organization_domains_status_idx` ON `organization_domains` (`verification_status`);--> statement-breakpoint
CREATE TABLE `permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`key` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `permissions_tenant_project_key_unq` ON `permissions` (`tenant_id`,`project_id`,`key`);--> statement-breakpoint
CREATE INDEX `permissions_tenant_status_id_idx` ON `permissions` (`tenant_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `permissions_tenant_project_status_id_idx` ON `permissions` (`tenant_id`,`project_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `permissions_tenant_project_idx` ON `permissions` (`tenant_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`role_id` text NOT NULL,
	`permission_id` text NOT NULL,
	`condition_expression` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_permissions_role_perm_unq` ON `role_permissions` (`role_id`,`permission_id`);--> statement-breakpoint
CREATE INDEX `role_permissions_tenant_role_idx` ON `role_permissions` (`tenant_id`,`role_id`);--> statement-breakpoint
CREATE INDEX `role_permissions_tenant_role_id_idx` ON `role_permissions` (`tenant_id`,`role_id`,`id`);--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`key` text NOT NULL,
	`display_name` text NOT NULL,
	`group` text,
	`status` text DEFAULT 'active' NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_tenant_project_key_unq` ON `roles` (`tenant_id`,`project_id`,`key`);--> statement-breakpoint
CREATE INDEX `roles_tenant_status_id_idx` ON `roles` (`tenant_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `roles_tenant_project_status_id_idx` ON `roles` (`tenant_id`,`project_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `roles_tenant_project_idx` ON `roles` (`tenant_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `user_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`role_id` text NOT NULL,
	`granted_via_grant_id` text,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_grants_unq` ON `user_grants` (`user_id`,`project_id`,`role_id`,`granted_via_grant_id`);--> statement-breakpoint
CREATE INDEX `user_grants_tenant_user_project_idx` ON `user_grants` (`tenant_id`,`user_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `user_grants_tenant_user_project_revoked_id_idx` ON `user_grants` (`tenant_id`,`user_id`,`project_id`,`revoked_at`,`id`);--> statement-breakpoint
CREATE INDEX `user_grants_via_grant_idx` ON `user_grants` (`granted_via_grant_id`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `access_token_issuances_tenant_jti_unq` ON `access_token_issuances` (`tenant_id`,`jti`);--> statement-breakpoint
CREATE INDEX `access_token_issuances_tenant_code_idx` ON `access_token_issuances` (`tenant_id`,`authorization_code`);--> statement-breakpoint
CREATE INDEX `access_token_issuances_tenant_family_idx` ON `access_token_issuances` (`tenant_id`,`refresh_family_id`);--> statement-breakpoint
CREATE INDEX `access_token_issuances_expires_idx` ON `access_token_issuances` (`expires_at`);--> statement-breakpoint
CREATE TABLE `access_token_revocations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`jti` text NOT NULL,
	`client_id` text NOT NULL,
	`subject` text,
	`expires_at` integer NOT NULL,
	`revoked_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_token_revocations_tenant_jti_unq` ON `access_token_revocations` (`tenant_id`,`jti`);--> statement-breakpoint
CREATE INDEX `access_token_revocations_tenant_client_idx` ON `access_token_revocations` (`tenant_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `access_token_revocations_expires_idx` ON `access_token_revocations` (`expires_at`);--> statement-breakpoint
CREATE TABLE `authorization_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text,
	`redirect_uri` text,
	`scope` text NOT NULL,
	`nonce` text,
	`code_challenge` text,
	`code_challenge_method` text,
	`dpop_jkt` text,
	`auth_time` integer NOT NULL,
	`acr` text,
	`amr` text,
	`resource` text,
	`authorization_details` text,
	`active_org_id` text,
	`project_grant_id` text,
	`consumed_at` integer,
	`replay_detected_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `authorization_codes_tenant_client_idx` ON `authorization_codes` (`tenant_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `authorization_codes_active_org_idx` ON `authorization_codes` (`active_org_id`);--> statement-breakpoint
CREATE INDEX `authorization_codes_project_grant_idx` ON `authorization_codes` (`project_grant_id`);--> statement-breakpoint
CREATE INDEX `authorization_codes_expires_idx` ON `authorization_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `oauth_consents` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`granted_scopes` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_consents_unq` ON `oauth_consents` (`tenant_id`,`user_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `oauth_consents_tenant_user_idx` ON `oauth_consents` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`family_id` text NOT NULL,
	`parent_token_id` text,
	`authorization_code` text,
	`user_id` text NOT NULL,
	`session_id` text,
	`client_id` text NOT NULL,
	`scope` text NOT NULL,
	`jkt` text,
	`active_org_id` text,
	`project_grant_id` text,
	`resource` text,
	`authorization_details` text,
	`auth_time` integer,
	`acr` text,
	`amr` text,
	`revoked_at` integer,
	`family_revoked_at` integer,
	`expires_at` integer NOT NULL,
	`absolute_expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_tokens_hash_unq` ON `refresh_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_tenant_family_idx` ON `refresh_tokens` (`tenant_id`,`family_id`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_tenant_authorization_code_idx` ON `refresh_tokens` (`tenant_id`,`authorization_code`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_tenant_user_idx` ON `refresh_tokens` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_active_org_idx` ON `refresh_tokens` (`active_org_id`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_project_grant_idx` ON `refresh_tokens` (`project_grant_id`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_expires_idx` ON `refresh_tokens` (`expires_at`);--> statement-breakpoint
CREATE TABLE `resource_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`audience` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`access_token_format` text DEFAULT 'jwt' NOT NULL,
	`signing_alg` text DEFAULT 'ES256' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resource_servers_tenant_audience_unq` ON `resource_servers` (`tenant_id`,`audience`);--> statement-breakpoint
CREATE INDEX `resource_servers_tenant_idx` ON `resource_servers` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `cert_store` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`usage` text NOT NULL,
	`certificate` text NOT NULL,
	`private_key_iv` blob NOT NULL,
	`private_key_ciphertext` blob NOT NULL,
	`private_key_tag` blob NOT NULL,
	`kek_version` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`not_before` integer,
	`not_after` integer,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cert_store_tenant_usage_status_idx` ON `cert_store` (`tenant_id`,`usage`,`status`);--> statement-breakpoint
CREATE INDEX `cert_store_tenant_usage_status_id_idx` ON `cert_store` (`tenant_id`,`usage`,`status`,`id`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `instance_signing_keys_instance_next_unq` ON `instance_signing_keys` (`instance_id`) WHERE "instance_signing_keys"."status" = 'next';--> statement-breakpoint
CREATE INDEX `instance_signing_keys_instance_status_idx` ON `instance_signing_keys` (`instance_id`,`status`);--> statement-breakpoint
CREATE TABLE `saml_service_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`org_id` text NOT NULL,
	`sp_entity_id` text NOT NULL,
	`acs_url` text NOT NULL,
	`slo_url` text,
	`slo_binding` text DEFAULT 'redirect' NOT NULL,
	`sp_certificates` text DEFAULT '[]' NOT NULL,
	`attribute_mapping` text DEFAULT '{}' NOT NULL,
	`name_id_format` text DEFAULT 'urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress' NOT NULL,
	`idp_signing_cert_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saml_service_providers_entity_unq` ON `saml_service_providers` (`tenant_id`,`org_id`,`sp_entity_id`);--> statement-breakpoint
CREATE INDEX `saml_service_providers_org_idx` ON `saml_service_providers` (`tenant_id`,`org_id`);--> statement-breakpoint
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
CREATE INDEX `saml_session_bindings_tenant_user_session_direction_id_idx` ON `saml_session_bindings` (`tenant_id`,`user_id`,`session_id`,`direction`,`id`);--> statement-breakpoint
CREATE INDEX `saml_session_bindings_name_idx` ON `saml_session_bindings` (`tenant_id`,`direction`,`scope_id`,`name_id`);--> statement-breakpoint
CREATE TABLE `sso_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`org_id` text NOT NULL,
	`protocol` text NOT NULL,
	`idp_entity_id` text,
	`idp_sso_url` text,
	`idp_slo_url` text,
	`idp_metadata_url` text,
	`idp_certificates` text DEFAULT '[]' NOT NULL,
	`oidc_client_id` text,
	`oidc_client_secret_ciphertext` blob,
	`oidc_discovery_url` text,
	`sp_cert_id` text,
	`want_authn_response_signed` integer DEFAULT true NOT NULL,
	`want_assertions_signed` integer DEFAULT true NOT NULL,
	`attribute_mapping` text DEFAULT '{}' NOT NULL,
	`role_mapping` text DEFAULT '{}' NOT NULL,
	`jit_enabled` integer DEFAULT true NOT NULL,
	`relay_state_url` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sso_connections_org_unq` ON `sso_connections` (`org_id`);--> statement-breakpoint
CREATE INDEX `sso_connections_tenant_idx` ON `sso_connections` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `sso_connections_tenant_status_id_idx` ON `sso_connections` (`tenant_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `sso_connections_tenant_org_status_id_idx` ON `sso_connections` (`tenant_id`,`org_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `sso_connections_tenant_status_idx` ON `sso_connections` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `directories` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`org_id` text NOT NULL,
	`provider` text NOT NULL,
	`scim_token_hash` text NOT NULL,
	`scim_token_hash_prev` text,
	`scim_token_prev_expires` integer,
	`sync_status` text DEFAULT 'idle' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_sync_at` integer,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `directories_tenant_org_status_id_idx` ON `directories` (`tenant_id`,`org_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `directories_tenant_status_id_idx` ON `directories` (`tenant_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `directories_tenant_org_idx` ON `directories` (`tenant_id`,`org_id`);--> statement-breakpoint
CREATE INDEX `directories_tenant_token_hash_idx` ON `directories` (`tenant_id`,`scim_token_hash`);--> statement-breakpoint
CREATE INDEX `directories_tenant_token_hash_prev_idx` ON `directories` (`tenant_id`,`scim_token_hash_prev`);--> statement-breakpoint
CREATE TABLE `directory_group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`group_id` text NOT NULL,
	`directory_user_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `directory_group_members_unq` ON `directory_group_members` (`group_id`,`directory_user_id`);--> statement-breakpoint
CREATE INDEX `directory_group_members_tenant_group_id_idx` ON `directory_group_members` (`tenant_id`,`group_id`,`id`);--> statement-breakpoint
CREATE TABLE `directory_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`directory_id` text NOT NULL,
	`display_name` text NOT NULL,
	`mapped_role` text,
	`status` text DEFAULT 'active' NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `directory_groups_dir_name_unq` ON `directory_groups` (`directory_id`,`display_name`);--> statement-breakpoint
CREATE INDEX `directory_groups_tenant_dir_id_idx` ON `directory_groups` (`tenant_id`,`directory_id`,`id`) WHERE "directory_groups"."status" <> 'deleted' AND "directory_groups"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `directory_groups_tenant_dir_created_id_idx` ON `directory_groups` (`tenant_id`,`directory_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `directory_groups_tenant_dir_updated_id_idx` ON `directory_groups` (`tenant_id`,`directory_id`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `directory_groups_tenant_dir_idx` ON `directory_groups` (`tenant_id`,`directory_id`);--> statement-breakpoint
CREATE TABLE `directory_pending_members` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`group_id` text NOT NULL,
	`ref` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `directory_pending_members_unq` ON `directory_pending_members` (`group_id`,`ref`);--> statement-breakpoint
CREATE INDEX `directory_pending_members_tenant_ref_id_idx` ON `directory_pending_members` (`tenant_id`,`ref`,`id`);--> statement-breakpoint
CREATE TABLE `directory_users` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`directory_id` text NOT NULL,
	`user_id` text,
	`external_id` text,
	`user_name` text NOT NULL,
	`scim_raw` text DEFAULT '{}' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `directory_users_dir_username_unq` ON `directory_users` (`directory_id`,`user_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `directory_users_dir_external_unq` ON `directory_users` (`directory_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `directory_users_tenant_dir_id_idx` ON `directory_users` (`tenant_id`,`directory_id`,`id`) WHERE "directory_users"."status" <> 'deleted' AND "directory_users"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `directory_users_tenant_dir_active_id_idx` ON `directory_users` (`tenant_id`,`directory_id`,`active`,`id`);--> statement-breakpoint
CREATE INDEX `directory_users_tenant_dir_created_id_idx` ON `directory_users` (`tenant_id`,`directory_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `directory_users_tenant_dir_updated_id_idx` ON `directory_users` (`tenant_id`,`directory_id`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `directory_users_tenant_dir_idx` ON `directory_users` (`tenant_id`,`directory_id`);--> statement-breakpoint
CREATE INDEX `directory_users_user_idx` ON `directory_users` (`user_id`);--> statement-breakpoint
CREATE TABLE `scim_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`org_id` text NOT NULL,
	`provider` text NOT NULL,
	`base_url` text NOT NULL,
	`token_secret_ref` text NOT NULL,
	`user_filter` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_sync_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scim_targets_tenant_org_idx` ON `scim_targets` (`tenant_id`,`org_id`);--> statement-breakpoint
CREATE INDEX `scim_targets_tenant_status_idx` ON `scim_targets` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`refresh_token_hash` text NOT NULL,
	`active_org_id` text,
	`device_fingerprint_hash` text,
	`device_name` text,
	`user_agent` text,
	`ip` text,
	`location` text,
	`status` text DEFAULT 'active' NOT NULL,
	`remember_me` integer DEFAULT false NOT NULL,
	`is_impersonation` integer DEFAULT false NOT NULL,
	`impersonator_user_id` text,
	`acr` text,
	`amr` text,
	`aal` integer,
	`authenticated_at` integer NOT NULL,
	`last_active_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_tenant_status_id_idx` ON `sessions` (`tenant_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `sessions_tenant_user_status_id_idx` ON `sessions` (`tenant_id`,`user_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `sessions_tenant_user_status_id_expires_idx` ON `sessions` (`tenant_id`,`user_id`,`status`,`id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `sessions_tenant_user_status_expires_idx` ON `sessions` (`tenant_id`,`user_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `sessions_tenant_user_status_idx` ON `sessions` (`tenant_id`,`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `sessions_refresh_token_idx` ON `sessions` (`refresh_token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_active_org_idx` ON `sessions` (`active_org_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`environment` text DEFAULT 'live' NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_unq` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_tenant_active_id_idx` ON `api_keys` (`tenant_id`,`id`) WHERE "api_keys"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX `api_keys_tenant_idx` ON `api_keys` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `audit_dead_letters` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`source_message_id` text,
	`tenant_id` text,
	`reason` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`body` text,
	`failed_at` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_dead_letters_message_id_unq` ON `audit_dead_letters` (`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `audit_dead_letters_tenant_source_message_id_unq` ON `audit_dead_letters` (`tenant_id`,`source_message_id`) WHERE "audit_dead_letters"."source_message_id" is not null;--> statement-breakpoint
CREATE INDEX `audit_dead_letters_tenant_idx` ON `audit_dead_letters` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `audit_dead_letters_failed_at_idx` ON `audit_dead_letters` (`failed_at`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`seq` integer NOT NULL,
	`id` text NOT NULL,
	`source_message_id` text,
	`tenant_id` text NOT NULL,
	`org_id` text,
	`event_type` text NOT NULL,
	`actor_id` text,
	`actor_ip` text,
	`target_type` text,
	`target_id` text,
	`meta` text DEFAULT '{}' NOT NULL,
	`occurred_at` text NOT NULL,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `seq`)
);
--> statement-breakpoint
CREATE INDEX `audit_events_tenant_occurred_id_idx` ON `audit_events` (`tenant_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `audit_events_occurred_id_idx` ON `audit_events` (`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `audit_events_event_idx` ON `audit_events` (`event_type`);--> statement-breakpoint
CREATE INDEX `audit_events_tenant_occurred_idx` ON `audit_events` (`tenant_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `audit_events_tenant_actor_idx` ON `audit_events` (`tenant_id`,`actor_id`);--> statement-breakpoint
CREATE INDEX `audit_events_tenant_event_idx` ON `audit_events` (`tenant_id`,`event_type`);--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_tenant_source_message_id_unq` ON `audit_events` (`tenant_id`,`source_message_id`) WHERE "audit_events"."source_message_id" is not null;--> statement-breakpoint
CREATE TABLE `notification_delivery_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`channel` text NOT NULL,
	`source_message_id` text NOT NULL,
	`delivery_identity` text NOT NULL,
	`provider` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text NOT NULL,
	`attempt_count` integer NOT NULL,
	`failed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_delivery_failures_tenant_identity_unq` ON `notification_delivery_failures` (`tenant_id`,`delivery_identity`);--> statement-breakpoint
CREATE INDEX `notification_delivery_failures_tenant_outcome_idx` ON `notification_delivery_failures` (`tenant_id`,`outcome`,`failed_at`);--> statement-breakpoint
CREATE INDEX `notification_delivery_failures_channel_source_idx` ON `notification_delivery_failures` (`channel`,`source_message_id`);--> statement-breakpoint
CREATE TABLE `notification_delivery_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`delivery_key` text NOT NULL,
	`source_message_id` text,
	`delivery_identity` text,
	`channel` text NOT NULL,
	`type` text NOT NULL,
	`provider` text,
	`recipient_hash` text NOT NULL,
	`recipient_iv` text NOT NULL,
	`recipient_ciphertext` text NOT NULL,
	`recipient_tag` text NOT NULL,
	`payload_iv` text NOT NULL,
	`payload_ciphertext` text NOT NULL,
	`payload_tag` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`available_at` integer NOT NULL,
	`lease_until` integer,
	`last_error_code` text,
	`failure_kind` text,
	`failed_at` integer,
	`provider_accepted_at` integer,
	`audit_queued_at` integer,
	`queued_at` integer,
	`delivered_at` integer,
	`dead_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_delivery_outbox_tenant_delivery_key_unq` ON `notification_delivery_outbox` (`tenant_id`,`delivery_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `notification_delivery_outbox_tenant_delivery_identity_unq` ON `notification_delivery_outbox` (`tenant_id`,`delivery_identity`) WHERE "notification_delivery_outbox"."delivery_identity" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `notification_delivery_outbox_tenant_ready_idx` ON `notification_delivery_outbox` (`tenant_id`,`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `notification_delivery_outbox_dispatch_idx` ON `notification_delivery_outbox` (`status`,`available_at`,`lease_until`);--> statement-breakpoint
CREATE INDEX `notification_delivery_outbox_failure_idx` ON `notification_delivery_outbox` (`status`,`failure_kind`,`failed_at`);--> statement-breakpoint
CREATE TABLE `notification_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`source_message_id` text,
	`tenant_id` text,
	`channel` text NOT NULL,
	`recipient` text NOT NULL,
	`type` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`provider` text,
	`reason` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`failed_at` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_failures_source_message_id_unq` ON `notification_failures` (`source_message_id`);--> statement-breakpoint
CREATE INDEX `notification_failures_tenant_idx` ON `notification_failures` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `notification_failures_channel_type_idx` ON `notification_failures` (`channel`,`type`);--> statement-breakpoint
CREATE INDEX `notification_failures_failed_at_idx` ON `notification_failures` (`failed_at`);--> statement-breakpoint
CREATE TABLE `platform_admins` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'platform_admin' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_admins_email_unq` ON `platform_admins` (`email`);--> statement-breakpoint
CREATE INDEX `platform_admins_instance_idx` ON `platform_admins` (`instance_id`);--> statement-breakpoint
CREATE TABLE `usage_daily` (
	`tenant_id` text NOT NULL,
	`day` text NOT NULL,
	`dau` integer DEFAULT 0 NOT NULL,
	`api_calls` integer DEFAULT 0 NOT NULL,
	`email_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `day`)
);
--> statement-breakpoint
CREATE INDEX `usage_daily_day_idx` ON `usage_daily` (`day`,`tenant_id`);--> statement-breakpoint
CREATE TABLE `usage_monthly` (
	`tenant_id` text NOT NULL,
	`year_month` text NOT NULL,
	`mau` integer NOT NULL,
	`archived_at` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `year_month`)
);
--> statement-breakpoint
CREATE INDEX `usage_monthly_year_month_idx` ON `usage_monthly` (`year_month`,`tenant_id`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`delivery_key` text,
	`tenant_id` text NOT NULL,
	`webhook_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`response_status` integer,
	`next_retry_at` integer,
	`delivered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_delivery_key_unq` ON `webhook_deliveries` (`delivery_key`) WHERE "webhook_deliveries"."delivery_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `webhook_deliveries_tenant_webhook_status_idx` ON `webhook_deliveries` (`tenant_id`,`webhook_id`,`status`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_status_retry_idx` ON `webhook_deliveries` (`status`,`next_retry_at`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`url` text NOT NULL,
	`event_types` text DEFAULT '[]' NOT NULL,
	`signing_secret_hash` text NOT NULL,
	`signing_secret_iv` text,
	`signing_secret_ciphertext` text,
	`signing_secret_tag` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhooks_tenant_status_id_idx` ON `webhooks` (`tenant_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `webhooks_tenant_status_idx` ON `webhooks` (`tenant_id`,`status`);--> statement-breakpoint
-- 手工维护:drizzle-kit 不建模 trigger,generate 产物永远不含下面两条。
-- 它们是 passkey 每用户上限 10 与 backup code 单批有效的唯一物理约束(安全语义,不是优化),
-- 取自原 0029_credential_cardinality.sql,重新 generate baseline 时必须重新套用。
CREATE TRIGGER `passkey_credentials_active_limit`
BEFORE INSERT ON `passkey_credentials`
WHEN (
  SELECT count(*)
  FROM `passkey_credentials`
  WHERE `tenant_id` = NEW.`tenant_id`
    AND `user_id` = NEW.`user_id`
    AND `revoked_at` IS NULL
) >= 10
BEGIN
  SELECT RAISE(ABORT, 'passkey_limit_exceeded');
END;
--> statement-breakpoint
CREATE TRIGGER `backup_codes_single_active_batch`
BEFORE INSERT ON `backup_codes`
BEGIN
  DELETE FROM `backup_codes`
  WHERE `tenant_id` = NEW.`tenant_id`
    AND `user_id` = NEW.`user_id`
    AND `batch_id` <> NEW.`batch_id`;
END;
