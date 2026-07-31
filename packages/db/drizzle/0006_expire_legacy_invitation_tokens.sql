-- Invitation tokens created before the tenant-bound xid_inv_v1 format contain no recoverable
-- Tenant locator. D1 stores only the complete token hash, so resolving those links from the
-- Instance apex would require a forbidden cross-Tenant hash lookup. Mark every pre-cutover pending
-- capability revoked and require the Organization administrator to resend it.
--
-- The default remains legacy so an old Worker briefly serving between `d1 migrations apply` and
-- the new Worker deployment cannot create an ambiguous token. The trigger fails that old insert
-- before that implementation reaches EMAIL_QUEUE.send. The new Worker always writes locator_v1.
ALTER TABLE `invitations` ADD `token_version` text NOT NULL DEFAULT 'legacy';--> statement-breakpoint
UPDATE `invitations`
SET
  `status` = 'revoked',
  `updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `status` = 'pending'
  AND `token_version` = 'legacy';--> statement-breakpoint
CREATE TRIGGER `invitations_reject_legacy_pending_before_insert`
BEFORE INSERT ON `invitations`
WHEN NEW.`status` = 'pending'
  AND NEW.`token_version` = 'legacy'
BEGIN
  SELECT RAISE(ABORT, 'legacy_invitation_token_disabled');
END;
