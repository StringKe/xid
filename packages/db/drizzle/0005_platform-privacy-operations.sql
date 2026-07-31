CREATE TABLE `compliance_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`document_type` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`storage_key` text,
	`checksum` text,
	`version` text NOT NULL,
	`accepted_by` text,
	`accepted_at` integer,
	`generated_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `compliance_documents_tenant_type_version_unq` ON `compliance_documents` (`tenant_id`,`document_type`,`version`);--> statement-breakpoint
CREATE INDEX `compliance_documents_type_status_idx` ON `compliance_documents` (`document_type`,`status`,`tenant_id`);--> statement-breakpoint
CREATE TABLE `organization_plans` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`plan` text DEFAULT 'free' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`external_customer_id` text,
	`trial_ends_at` integer,
	`effective_at` integer NOT NULL,
	`updated_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_plans_external_customer_unq` ON `organization_plans` (`external_customer_id`) WHERE "organization_plans"."external_customer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `organization_plans_plan_status_idx` ON `organization_plans` (`plan`,`status`,`tenant_id`);--> statement-breakpoint
CREATE TABLE `organization_quotas` (
	`tenant_id` text NOT NULL,
	`quota_key` text NOT NULL,
	`limit` integer,
	`enforcement` text DEFAULT 'observe' NOT NULL,
	`updated_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `quota_key`)
);
--> statement-breakpoint
CREATE INDEX `organization_quotas_key_tenant_idx` ON `organization_quotas` (`quota_key`,`tenant_id`);--> statement-breakpoint
INSERT INTO `organization_quotas` (
	`tenant_id`, `quota_key`, `limit`, `enforcement`, `updated_by`, `created_at`, `updated_at`
)
SELECT
	`organizations`.`tenant_id`,
	'seats',
	`organizations`.`seat_limit`,
	'block_creation',
	NULL,
	`organizations`.`created_at`,
	`organizations`.`updated_at`
FROM `organizations`
WHERE `organizations`.`parent_org_id` IS NULL
ON CONFLICT (`tenant_id`, `quota_key`) DO NOTHING;--> statement-breakpoint
CREATE TABLE `billing_meter_reports` (
	`tenant_id` text NOT NULL,
	`meter_key` text NOT NULL,
	`period` text NOT NULL,
	`reported_value` integer DEFAULT 0 NOT NULL,
	`pending_identifier` text,
	`pending_value` integer,
	`pending_target` integer,
	`pending_customer_id` text,
	`pending_event_name` text,
	`pending_timestamp` integer,
	`pending_reserved_at` integer,
	`provider_accepted_at` integer,
	`reconciliation_required_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `meter_key`, `period`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_meter_reports_pending_identifier_unq` ON `billing_meter_reports` (`pending_identifier`) WHERE "billing_meter_reports"."pending_identifier" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `billing_meter_reports_period_meter_tenant_idx` ON `billing_meter_reports` (`period`,`meter_key`,`tenant_id`);--> statement-breakpoint
CREATE TABLE `stripe_checkout_reservations` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`plan` text NOT NULL,
	`customer_id` text,
	`provider_idempotency_key` text NOT NULL,
	`session_id` text,
	`session_url` text,
	`expires_at` integer,
	`status` text DEFAULT 'reserved' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_checkout_reservations_provider_key_unq` ON `stripe_checkout_reservations` (`provider_idempotency_key`);--> statement-breakpoint
CREATE INDEX `stripe_checkout_reservations_status_expiry_idx` ON `stripe_checkout_reservations` (`status`,`expires_at`,`tenant_id`);--> statement-breakpoint
CREATE TABLE `stripe_webhook_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`tenant_id` text,
	`event_created` integer NOT NULL,
	`status` text NOT NULL,
	`error_code` text,
	`processed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stripe_webhook_events_status_created_event_idx` ON `stripe_webhook_events` (`status`,`created_at`,`event_id`);--> statement-breakpoint
CREATE INDEX `stripe_webhook_events_tenant_event_created_idx` ON `stripe_webhook_events` (`tenant_id`,`event_created`,`event_id`);--> statement-breakpoint
CREATE TABLE `platform_announcements` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_type` text DEFAULT 'global' NOT NULL,
	`scope_value` text,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`severity` text DEFAULT 'info' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `platform_announcements_status_window_idx` ON `platform_announcements` (`status`,`starts_at`,`ends_at`);--> statement-breakpoint
CREATE INDEX `platform_announcements_scope_idx` ON `platform_announcements` (`scope_type`,`scope_value`,`status`);--> statement-breakpoint
CREATE TABLE `platform_audit_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`org_id` text,
	`action` text NOT NULL,
	`actor_id` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`available_at` integer NOT NULL,
	`queued_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `platform_audit_outbox_ready_idx` ON `platform_audit_outbox` (`status`,`available_at`,`id`);--> statement-breakpoint
CREATE INDEX `platform_audit_outbox_tenant_created_idx` ON `platform_audit_outbox` (`tenant_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `privacy_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`request_type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`storage_key` text,
	`content_type` text,
	`available_at` integer,
	`expires_at` integer,
	`scheduled_for` integer,
	`processing_started_at` integer,
	`completed_at` integer,
	`canceled_at` integer,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `privacy_requests_tenant_user_created_idx` ON `privacy_requests` (`tenant_id`,`user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `privacy_requests_due_idx` ON `privacy_requests` (`request_type`,`status`,`scheduled_for`,`id`);--> statement-breakpoint
CREATE TABLE `status_incident_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`status` text NOT NULL,
	`message` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `status_incident_updates_incident_created_idx` ON `status_incident_updates` (`incident_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `status_incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'investigating' NOT NULL,
	`impact` text DEFAULT 'minor' NOT NULL,
	`summary` text NOT NULL,
	`started_at` integer NOT NULL,
	`resolved_at` integer,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `status_incidents_status_started_idx` ON `status_incidents` (`status`,`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `status_incidents_started_id_idx` ON `status_incidents` (`started_at`,`id`);--> statement-breakpoint
ALTER TABLE `users` ADD `erased_at` integer;--> statement-breakpoint
CREATE TRIGGER `memberships_seat_limit_before_insert`
BEFORE INSERT ON `memberships`
WHEN NEW.`status` = 'active'
 AND NOT EXISTS (
	SELECT 1
	FROM `memberships`
	WHERE `memberships`.`tenant_id` = NEW.`tenant_id`
	  AND `memberships`.`user_id` = NEW.`user_id`
	  AND `memberships`.`status` = 'active'
 )
 AND COALESCE((
	SELECT `enforcement`
	FROM `organization_quotas`
	WHERE `tenant_id` = NEW.`tenant_id`
	  AND `quota_key` = 'seats'
 ), 'observe') = 'block_creation'
 AND (
	SELECT `limit`
	FROM `organization_quotas`
	WHERE `tenant_id` = NEW.`tenant_id`
	  AND `quota_key` = 'seats'
 ) IS NOT NULL
 AND (
	SELECT COUNT(DISTINCT `memberships`.`user_id`)
	FROM `memberships`
	WHERE `memberships`.`tenant_id` = NEW.`tenant_id`
	  AND `memberships`.`status` = 'active'
 ) >= (
	SELECT `limit`
	FROM `organization_quotas`
	WHERE `tenant_id` = NEW.`tenant_id`
	  AND `quota_key` = 'seats'
 )
BEGIN
	SELECT RAISE(ABORT, 'seat_limit_exceeded');
END;--> statement-breakpoint
CREATE TRIGGER `memberships_seat_limit_before_update`
BEFORE UPDATE OF `status`, `tenant_id`, `org_id`, `user_id` ON `memberships`
WHEN NEW.`status` = 'active'
 AND NOT EXISTS (
	SELECT 1
	FROM `memberships`
	WHERE `memberships`.`tenant_id` = NEW.`tenant_id`
	  AND `memberships`.`user_id` = NEW.`user_id`
	  AND `memberships`.`status` = 'active'
	  AND `memberships`.`id` <> OLD.`id`
 )
 AND COALESCE((
	SELECT `enforcement`
	FROM `organization_quotas`
	WHERE `tenant_id` = NEW.`tenant_id`
	  AND `quota_key` = 'seats'
 ), 'observe') = 'block_creation'
 AND (
	SELECT `limit`
	FROM `organization_quotas`
	WHERE `tenant_id` = NEW.`tenant_id`
	  AND `quota_key` = 'seats'
 ) IS NOT NULL
 AND (
	SELECT COUNT(DISTINCT `memberships`.`user_id`)
	FROM `memberships`
	WHERE `memberships`.`tenant_id` = NEW.`tenant_id`
	  AND `memberships`.`status` = 'active'
	  AND `memberships`.`id` <> OLD.`id`
 ) >= (
	SELECT `limit`
	FROM `organization_quotas`
	WHERE `tenant_id` = NEW.`tenant_id`
	  AND `quota_key` = 'seats'
 )
BEGIN
	SELECT RAISE(ABORT, 'seat_limit_exceeded');
END;
--> statement-breakpoint
CREATE TRIGGER `organizations_quota_before_insert`
BEFORE INSERT ON `organizations`
WHEN NEW.`parent_org_id` IS NOT NULL
 AND NEW.`deleted_at` IS NULL
 AND COALESCE((
	SELECT `enforcement`
	FROM `organization_quotas`
	WHERE `tenant_id` = NEW.`tenant_id`
	  AND `quota_key` = 'organizations'
 ), 'observe') = 'block_creation'
 AND (
	SELECT `limit`
	FROM `organization_quotas`
	WHERE `tenant_id` = NEW.`tenant_id`
	  AND `quota_key` = 'organizations'
 ) IS NOT NULL
 AND (
	SELECT COUNT(*)
	FROM `organizations`
	WHERE `tenant_id` = NEW.`tenant_id`
	  AND `parent_org_id` IS NOT NULL
	  AND `deleted_at` IS NULL
 ) >= (
	SELECT `limit`
	FROM `organization_quotas`
	WHERE `tenant_id` = NEW.`tenant_id`
	  AND `quota_key` = 'organizations'
 )
BEGIN
	SELECT RAISE(ABORT, 'resource_quota_exceeded');
END;
--> statement-breakpoint
CREATE TRIGGER `organizations_quota_before_update`
BEFORE UPDATE OF `status`, `deleted_at`, `tenant_id`, `parent_org_id` ON `organizations`
WHEN NEW.`parent_org_id` IS NOT NULL
 AND NEW.`deleted_at` IS NULL
 AND (
	OLD.`deleted_at` IS NOT NULL
	OR OLD.`status` = 'deleted'
	OR OLD.`tenant_id` <> NEW.`tenant_id`
	OR OLD.`parent_org_id` IS NULL
 )
 AND COALESCE((
	SELECT `enforcement`
	FROM `organization_quotas`
	WHERE `tenant_id` = NEW.`tenant_id`
	  AND `quota_key` = 'organizations'
 ), 'observe') = 'block_creation'
 AND (
	SELECT `limit`
	FROM `organization_quotas`
	WHERE `tenant_id` = NEW.`tenant_id`
	  AND `quota_key` = 'organizations'
 ) IS NOT NULL
 AND (
	SELECT COUNT(*)
	FROM `organizations`
	WHERE `tenant_id` = NEW.`tenant_id`
	  AND `parent_org_id` IS NOT NULL
	  AND `deleted_at` IS NULL
	  AND `id` <> OLD.`id`
 ) >= (
	SELECT `limit`
	FROM `organization_quotas`
	WHERE `tenant_id` = NEW.`tenant_id`
	  AND `quota_key` = 'organizations'
 )
BEGIN
	SELECT RAISE(ABORT, 'resource_quota_exceeded');
END;
--> statement-breakpoint
CREATE TRIGGER `sso_connections_quota_before_insert`
BEFORE INSERT ON `sso_connections`
WHEN NEW.`status` <> 'deleted'
 AND COALESCE((
	SELECT `enforcement`
	FROM `organization_quotas`
	WHERE `tenant_id` = NEW.`tenant_id`
	  AND `quota_key` = 'sso_connections'
 ), 'observe') = 'block_creation'
 AND (
	SELECT `limit`
	FROM `organization_quotas`
	WHERE `tenant_id` = NEW.`tenant_id`
	  AND `quota_key` = 'sso_connections'
 ) IS NOT NULL
 AND (
	SELECT COUNT(*)
	FROM `sso_connections`
	WHERE `tenant_id` = NEW.`tenant_id`
	  AND `status` <> 'deleted'
 ) >= (
	SELECT `limit`
	FROM `organization_quotas`
	WHERE `tenant_id` = NEW.`tenant_id`
	  AND `quota_key` = 'sso_connections'
 )
BEGIN
	SELECT RAISE(ABORT, 'resource_quota_exceeded');
END;
--> statement-breakpoint
CREATE TRIGGER `sso_connections_quota_before_update`
BEFORE UPDATE OF `status`, `tenant_id` ON `sso_connections`
WHEN NEW.`status` <> 'deleted'
 AND (
	OLD.`status` = 'deleted'
	OR OLD.`tenant_id` <> NEW.`tenant_id`
 )
 AND COALESCE((
	SELECT `enforcement`
	FROM `organization_quotas`
	WHERE `tenant_id` = NEW.`tenant_id`
	  AND `quota_key` = 'sso_connections'
 ), 'observe') = 'block_creation'
 AND (
	SELECT `limit`
	FROM `organization_quotas`
	WHERE `tenant_id` = NEW.`tenant_id`
	  AND `quota_key` = 'sso_connections'
 ) IS NOT NULL
 AND (
	SELECT COUNT(*)
	FROM `sso_connections`
	WHERE `tenant_id` = NEW.`tenant_id`
	  AND `status` <> 'deleted'
	  AND `id` <> OLD.`id`
 ) >= (
	SELECT `limit`
	FROM `organization_quotas`
	WHERE `tenant_id` = NEW.`tenant_id`
	  AND `quota_key` = 'sso_connections'
 )
BEGIN
	SELECT RAISE(ABORT, 'resource_quota_exceeded');
END;
