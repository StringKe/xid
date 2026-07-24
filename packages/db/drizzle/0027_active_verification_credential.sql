CREATE UNIQUE INDEX `verification_tokens_active_credential_unq`
  ON `verification_tokens` (`tenant_id`, `user_id`, `purpose`, COALESCE(`channel`, ''))
  WHERE `consumed_at` IS NULL AND `purpose` IN ('magic_link', 'otp');
