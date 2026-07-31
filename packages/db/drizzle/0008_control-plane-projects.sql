CREATE UNIQUE INDEX `manager_assignments_tenant_scope_unq` ON `manager_assignments` (`tenant_id`,`user_id`,`manager_role`,`scope_type`,`scope_id`) WHERE "manager_assignments"."scope_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM `manager_assignments`
WHERE `manager_role` = 'instance_manager'
  AND `scope_type` = 'instance'
  AND `scope_id` IS NULL
  AND EXISTS (
    SELECT 1
    FROM `manager_assignments` AS `retained`
    WHERE `retained`.`tenant_id` = `manager_assignments`.`tenant_id`
      AND `retained`.`user_id` = `manager_assignments`.`user_id`
      AND `retained`.`manager_role` = `manager_assignments`.`manager_role`
      AND `retained`.`scope_type` = `manager_assignments`.`scope_type`
      AND `retained`.`scope_id` IS NULL
      AND `retained`.`id` < `manager_assignments`.`id`
  );--> statement-breakpoint
CREATE UNIQUE INDEX `manager_assignments_instance_unq` ON `manager_assignments` (`tenant_id`,`user_id`,`manager_role`,`scope_type`) WHERE "manager_assignments"."manager_role" = 'instance_manager'
          AND "manager_assignments"."scope_type" = 'instance'
          AND "manager_assignments"."scope_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `role_permissions_tenant_role_perm_unq` ON `role_permissions` (`tenant_id`,`role_id`,`permission_id`);--> statement-breakpoint
ALTER TABLE `projects` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `deleted_at` integer;--> statement-breakpoint
CREATE INDEX `projects_tenant_status_id_idx` ON `projects` (`tenant_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `projects_tenant_org_status_id_idx` ON `projects` (`tenant_id`,`org_id`,`status`,`id`);
