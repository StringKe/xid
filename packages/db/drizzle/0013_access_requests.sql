CREATE TABLE `access_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`role_id` text,
	`requester_user_id` text NOT NULL,
	`justification` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`approver_user_id` text,
	`decided_at` integer,
	`decision_reason` text,
	`grant_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_requests_pending_unq` ON `access_requests` (`tenant_id`,`project_id`,`requester_user_id`) WHERE "access_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `access_requests_tenant_org_status_idx` ON `access_requests` (`tenant_id`,`org_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `access_requests_tenant_project_status_idx` ON `access_requests` (`tenant_id`,`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `access_requests_tenant_requester_idx` ON `access_requests` (`tenant_id`,`requester_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `access_requests_approver_idx` ON `access_requests` (`tenant_id`,`approver_user_id`,`status`);--> statement-breakpoint
ALTER TABLE `projects` ADD `access_policy` text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_grants` ADD `granted_via_request_id` text;--> statement-breakpoint
ALTER TABLE `user_grants` ADD `expires_at` integer;