CREATE UNIQUE INDEX `org_unit_members_tenant_unq` ON `org_unit_members` (`tenant_id`,`unit_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `org_units_tenant_org_path_idx` ON `org_units` (`tenant_id`,`org_id`,`path`);
