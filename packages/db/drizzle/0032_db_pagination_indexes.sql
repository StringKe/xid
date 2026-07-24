CREATE INDEX `sessions_tenant_user_status_id_expires_idx` ON `sessions` (`tenant_id`,`user_id`,`status`,`id`,`expires_at`);
--> statement-breakpoint
CREATE INDEX `directory_users_tenant_dir_active_id_idx` ON `directory_users` (`tenant_id`,`directory_id`,`active`,`id`);
--> statement-breakpoint
CREATE INDEX `directory_users_tenant_dir_created_id_idx` ON `directory_users` (`tenant_id`,`directory_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `directory_users_tenant_dir_updated_id_idx` ON `directory_users` (`tenant_id`,`directory_id`,`updated_at`,`id`);
--> statement-breakpoint
CREATE INDEX `directory_groups_tenant_dir_created_id_idx` ON `directory_groups` (`tenant_id`,`directory_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `directory_groups_tenant_dir_updated_id_idx` ON `directory_groups` (`tenant_id`,`directory_id`,`updated_at`,`id`);
--> statement-breakpoint
CREATE INDEX `directory_group_members_tenant_group_id_idx` ON `directory_group_members` (`tenant_id`,`group_id`,`id`);
--> statement-breakpoint
CREATE INDEX `directory_pending_members_tenant_ref_id_idx` ON `directory_pending_members` (`tenant_id`,`ref`,`id`);
--> statement-breakpoint
CREATE INDEX `role_permissions_tenant_role_id_idx` ON `role_permissions` (`tenant_id`,`role_id`,`id`);
--> statement-breakpoint
CREATE INDEX `user_grants_tenant_user_project_revoked_id_idx` ON `user_grants` (`tenant_id`,`user_id`,`project_id`,`revoked_at`,`id`);
--> statement-breakpoint
CREATE INDEX `cert_store_tenant_usage_status_id_idx` ON `cert_store` (`tenant_id`,`usage`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `saml_session_bindings_tenant_user_session_direction_id_idx` ON `saml_session_bindings` (`tenant_id`,`user_id`,`session_id`,`direction`,`id`);
