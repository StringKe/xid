CREATE INDEX `users_username_active_lookup_idx` ON `users` (`username`,`tenant_id`) WHERE `deleted_at` IS NULL AND `status` = 'active';
--> statement-breakpoint
CREATE INDEX `users_external_id_active_lookup_idx` ON `users` (`external_id`,`tenant_id`) WHERE `deleted_at` IS NULL AND `status` = 'active';
--> statement-breakpoint
CREATE INDEX `users_active_cursor_idx` ON `users` (`tenant_id`,`id`) WHERE `deleted_at` IS NULL AND `status` <> 'deleted';
--> statement-breakpoint
CREATE INDEX `users_active_global_idx` ON `users` (`id`) WHERE `deleted_at` IS NULL AND `status` <> 'deleted';
--> statement-breakpoint
CREATE INDEX `user_emails_email_lookup_idx` ON `user_emails` (`email`,`user_id`,`tenant_id`);
--> statement-breakpoint
CREATE INDEX `user_emails_user_primary_idx` ON `user_emails` (`user_id`,`is_primary`);
--> statement-breakpoint
CREATE INDEX `user_phones_phone_lookup_idx` ON `user_phones` (`phone`,`user_id`,`tenant_id`);
--> statement-breakpoint
CREATE INDEX `organizations_instance_slug_idx` ON `organizations` (`instance_id`,`slug`);
--> statement-breakpoint
CREATE INDEX `organizations_top_level_id_idx` ON `organizations` (`id`) WHERE `parent_org_id` IS NULL;
--> statement-breakpoint
CREATE INDEX `organizations_active_id_idx` ON `organizations` (`id`) WHERE `status` = 'active';
--> statement-breakpoint
CREATE INDEX `organizations_tenant_status_id_idx` ON `organizations` (`tenant_id`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `organizations_parent_id_idx` ON `organizations` (`parent_org_id`,`id`);
--> statement-breakpoint
CREATE INDEX `applications_tenant_status_id_idx` ON `applications` (`tenant_id`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `project_grants_tenant_status_id_idx` ON `project_grants` (`tenant_id`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `project_grants_tenant_project_status_id_idx` ON `project_grants` (`tenant_id`,`granted_project_id`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `project_grants_tenant_to_org_status_id_idx` ON `project_grants` (`tenant_id`,`granted_to_org_id`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `roles_tenant_status_id_idx` ON `roles` (`tenant_id`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `roles_tenant_project_status_id_idx` ON `roles` (`tenant_id`,`project_id`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `permissions_tenant_status_id_idx` ON `permissions` (`tenant_id`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `permissions_tenant_project_status_id_idx` ON `permissions` (`tenant_id`,`project_id`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `memberships_tenant_org_status_id_idx` ON `memberships` (`tenant_id`,`org_id`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `invitations_tenant_org_status_id_idx` ON `invitations` (`tenant_id`,`org_id`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `sessions_tenant_status_id_idx` ON `sessions` (`tenant_id`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `sessions_tenant_user_status_id_idx` ON `sessions` (`tenant_id`,`user_id`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `directories_tenant_org_status_id_idx` ON `directories` (`tenant_id`,`org_id`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `directories_tenant_status_id_idx` ON `directories` (`tenant_id`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `directory_users_tenant_dir_id_idx` ON `directory_users` (`tenant_id`,`directory_id`,`id`) WHERE `status` <> 'deleted' AND `deleted_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `directory_groups_tenant_dir_id_idx` ON `directory_groups` (`tenant_id`,`directory_id`,`id`) WHERE `status` <> 'deleted' AND `deleted_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `sso_connections_tenant_status_id_idx` ON `sso_connections` (`tenant_id`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `sso_connections_tenant_org_status_id_idx` ON `sso_connections` (`tenant_id`,`org_id`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `audit_events_tenant_occurred_id_idx` ON `audit_events` (`tenant_id`,`occurred_at`,`id`);
--> statement-breakpoint
CREATE INDEX `audit_events_occurred_id_idx` ON `audit_events` (`occurred_at`,`id`);
--> statement-breakpoint
CREATE INDEX `audit_events_event_idx` ON `audit_events` (`event_type`);
--> statement-breakpoint
CREATE INDEX `usage_daily_day_idx` ON `usage_daily` (`day`,`tenant_id`);
--> statement-breakpoint
CREATE INDEX `usage_monthly_year_month_idx` ON `usage_monthly` (`year_month`,`tenant_id`);
--> statement-breakpoint
CREATE INDEX `webhooks_tenant_status_id_idx` ON `webhooks` (`tenant_id`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `api_keys_tenant_active_id_idx` ON `api_keys` (`tenant_id`,`id`) WHERE `revoked_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `memberships_tenant_user_status_id_idx` ON `memberships` (`tenant_id`,`user_id`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `organization_domains_tenant_org_status_id_idx` ON `organization_domains` (`tenant_id`,`org_id`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `user_identities_tenant_user_type_active_idx` ON `user_identities` (`tenant_id`,`user_id`,`identity_type`,`id`) WHERE `revoked_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `user_emails_tenant_user_primary_created_idx` ON `user_emails` (`tenant_id`,`user_id`,`is_primary`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `sessions_tenant_user_status_expires_idx` ON `sessions` (`tenant_id`,`user_id`,`status`,`expires_at`);
--> statement-breakpoint
CREATE INDEX `directories_tenant_token_hash_idx` ON `directories` (`tenant_id`,`scim_token_hash`);
--> statement-breakpoint
CREATE INDEX `directories_tenant_token_hash_prev_idx` ON `directories` (`tenant_id`,`scim_token_hash_prev`);
--> statement-breakpoint
CREATE INDEX `passkey_credentials_tenant_user_active_idx` ON `passkey_credentials` (`tenant_id`,`user_id`,`id`) WHERE `revoked_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `backup_codes_tenant_user_used_idx` ON `backup_codes` (`tenant_id`,`user_id`,`used`);
--> statement-breakpoint
CREATE INDEX `trusted_devices_tenant_user_active_idx` ON `trusted_devices` (`tenant_id`,`user_id`,`expires_at`,`id`) WHERE `revoked_at` IS NULL;
