CREATE TRIGGER `passkey_credentials_active_limit`
BEFORE INSERT ON `passkey_credentials`
WHEN (
  SELECT count(*)
  FROM `passkey_credentials`
  WHERE `tenant_id` = NEW.`tenant_id`
    AND `user_id` = NEW.`user_id`
    AND `revoked_at` IS NULL
) >= 10
BEGIN
  SELECT RAISE(ABORT, 'passkey_limit_exceeded');
END;
--> statement-breakpoint
CREATE TRIGGER `backup_codes_single_active_batch`
BEFORE INSERT ON `backup_codes`
BEGIN
  DELETE FROM `backup_codes`
  WHERE `tenant_id` = NEW.`tenant_id`
    AND `user_id` = NEW.`user_id`
    AND `batch_id` <> NEW.`batch_id`;
END;
