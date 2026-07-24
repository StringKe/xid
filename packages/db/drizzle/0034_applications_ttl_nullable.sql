-- applications.access_token_ttl_sec 改可空:NULL = 继承租户 token 策略(application -> org -> instance 三层解析)。
-- SQLite 不支持 ALTER COLUMN 改约束,applications 是小型配置表,走标准表重建;INSERT SELECT 全列拷贝,存量值原样保留。
CREATE TABLE `__new_applications` (
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
INSERT INTO `__new_applications`(`id`, `tenant_id`, `project_id`, `client_id`, `client_secret_hash`, `client_type`, `token_endpoint_auth_method`, `jwks`, `redirect_uris`, `post_logout_redirect_uris`, `frontchannel_logout_uri`, `backchannel_logout_uri`, `allowed_grant_types`, `allowed_response_types`, `allowed_scopes`, `require_pkce`, `dpop_bound_access_tokens`, `access_token_format`, `access_token_ttl_sec`, `id_token_signed_alg`, `first_party`, `require_org_context`, `custom_claims_config`, `registration_access_token_hash`, `status`, `created_at`, `updated_at`) SELECT `id`, `tenant_id`, `project_id`, `client_id`, `client_secret_hash`, `client_type`, `token_endpoint_auth_method`, `jwks`, `redirect_uris`, `post_logout_redirect_uris`, `frontchannel_logout_uri`, `backchannel_logout_uri`, `allowed_grant_types`, `allowed_response_types`, `allowed_scopes`, `require_pkce`, `dpop_bound_access_tokens`, `access_token_format`, `access_token_ttl_sec`, `id_token_signed_alg`, `first_party`, `require_org_context`, `custom_claims_config`, `registration_access_token_hash`, `status`, `created_at`, `updated_at` FROM `applications`;
--> statement-breakpoint
DROP TABLE `applications`;
--> statement-breakpoint
ALTER TABLE `__new_applications` RENAME TO `applications`;
--> statement-breakpoint
CREATE UNIQUE INDEX `applications_client_id_unq` ON `applications` (`client_id`);
--> statement-breakpoint
CREATE INDEX `applications_tenant_project_idx` ON `applications` (`tenant_id`,`project_id`);
--> statement-breakpoint
CREATE INDEX `applications_tenant_status_id_idx` ON `applications` (`tenant_id`,`status`,`id`);
--> statement-breakpoint
CREATE INDEX `applications_tenant_status_idx` ON `applications` (`tenant_id`,`status`);
