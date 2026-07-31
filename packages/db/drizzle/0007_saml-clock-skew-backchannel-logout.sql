ALTER TABLE `applications` ADD `backchannel_logout_session_required` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sso_connections` ADD `saml_clock_skew_ms` integer DEFAULT 180000 NOT NULL;--> statement-breakpoint
CREATE TRIGGER `organizations_hierarchy_insert_guard`
BEFORE INSERT ON `organizations`
WHEN
  (
    NEW.`id` = NEW.`tenant_id`
    AND NEW.`parent_org_id` IS NOT NULL
  )
  OR
  (
    NEW.`id` <> NEW.`tenant_id`
    AND (
      NEW.`parent_org_id` IS NULL
      OR NEW.`parent_org_id` <> NEW.`tenant_id`
      OR NOT EXISTS (
        SELECT 1
        FROM `organizations` AS parent
        WHERE parent.`id` = NEW.`tenant_id`
          AND parent.`tenant_id` = NEW.`tenant_id`
          AND parent.`instance_id` = NEW.`instance_id`
          AND parent.`parent_org_id` IS NULL
          AND parent.`status` = 'active'
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'organization_hierarchy_invalid');
END;--> statement-breakpoint
CREATE TRIGGER `organizations_hierarchy_update_guard`
BEFORE UPDATE OF `id`, `tenant_id`, `instance_id`, `parent_org_id`, `status`, `deleted_at`
ON `organizations`
WHEN
  NEW.`id` <> OLD.`id`
  OR NEW.`tenant_id` <> OLD.`tenant_id`
  OR NEW.`instance_id` <> OLD.`instance_id`
  OR NOT (NEW.`parent_org_id` IS OLD.`parent_org_id`)
  OR (
    NEW.`id` = NEW.`tenant_id`
    AND NEW.`parent_org_id` IS NOT NULL
  )
  OR (
    NEW.`id` <> NEW.`tenant_id`
    AND (
      NEW.`parent_org_id` IS NULL
      OR NEW.`parent_org_id` <> NEW.`tenant_id`
      OR NOT EXISTS (
        SELECT 1
        FROM `organizations` AS parent
        WHERE parent.`id` = NEW.`tenant_id`
          AND parent.`tenant_id` = NEW.`tenant_id`
          AND parent.`instance_id` = NEW.`instance_id`
          AND parent.`parent_org_id` IS NULL
          AND (NEW.`status` <> 'active' OR parent.`status` = 'active')
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'organization_hierarchy_invalid');
END;
