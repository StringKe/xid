DROP TRIGGER IF EXISTS `memberships_seat_limit_before_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `memberships_seat_limit_before_update`;--> statement-breakpoint
UPDATE `organization_quotas` SET `enforcement` = 'observe', `updated_at` = CAST(strftime('%s', 'now') AS integer) * 1000 WHERE `quota_key` = 'seats' AND `enforcement` = 'block_creation';
