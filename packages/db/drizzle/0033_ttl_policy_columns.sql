ALTER TABLE `instances` ADD `token_policy` text;
--> statement-breakpoint
ALTER TABLE `org_policies` ADD `token_policy` text;
--> statement-breakpoint
-- TTL 收口:旧 bootstrap 默认会话策略(idle 30min / absolute 7d)升级为 3d/30d,与 DEFAULT_SESSION_POLICY 对齐;
-- 仅命中旧默认的行更新,自定义值不动。幂等:更新后不再匹配 WHERE 条件,可重复执行。
UPDATE `instances`
SET `session_policy` = json_set(`session_policy`, '$.idle_timeout_min', 4320, '$.absolute_timeout_days', 30),
    `updated_at` = unixepoch('subsec') * 1000
WHERE json_extract(`session_policy`, '$.idle_timeout_min') = 30
  AND json_extract(`session_policy`, '$.absolute_timeout_days') = 7;
