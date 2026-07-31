ALTER TABLE `user_emails` ADD `ownership_proof` text;--> statement-breakpoint
ALTER TABLE `user_emails` ADD `ownership_proof_ceremony_id` text;--> statement-breakpoint
ALTER TABLE `user_emails` ADD `ownership_proven_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `user_emails_tenant_ownership_ceremony_unq` ON `user_emails` (`tenant_id`,`ownership_proof_ceremony_id`) WHERE "user_emails"."ownership_proof_ceremony_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `user_emails_tenant_ownership_proof_idx` ON `user_emails` (`tenant_id`,`ownership_proof`,`user_id`);--> statement-breakpoint
ALTER TABLE `invitations` ADD `email_claim_token_hash` text;--> statement-breakpoint
ALTER TABLE `invitations` ADD `email_claim_email_hash` text;--> statement-breakpoint
ALTER TABLE `invitations` ADD `email_claim_expires_at` integer;--> statement-breakpoint
ALTER TABLE `invitations` ADD `email_claim_consumed_at` integer;--> statement-breakpoint
ALTER TABLE `invitations` ADD `email_claim_consumption_id` text;--> statement-breakpoint
ALTER TABLE `invitations` ADD `email_claim_user_id` text;--> statement-breakpoint
ALTER TABLE `invitations` ADD `email_claim_recovery_hash` text;--> statement-breakpoint
ALTER TABLE `invitations` ADD `email_claim_session_id` text;--> statement-breakpoint
ALTER TABLE `invitations` ADD `email_claim_session_reserved_at` integer;--> statement-breakpoint
ALTER TABLE `invitations` ADD `email_claim_finalization_id` text;--> statement-breakpoint
ALTER TABLE `invitations` ADD `displaced_user_id` text;--> statement-breakpoint
ALTER TABLE `invitations` ADD `displaced_email_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_email_claim_token_unq` ON `invitations` (`email_claim_token_hash`) WHERE "invitations"."email_claim_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_email_claim_consumption_unq` ON `invitations` (`email_claim_consumption_id`) WHERE "invitations"."email_claim_consumption_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_email_claim_recovery_unq` ON `invitations` (`email_claim_recovery_hash`) WHERE "invitations"."email_claim_recovery_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_email_claim_finalization_unq` ON `invitations` (`email_claim_finalization_id`) WHERE "invitations"."email_claim_finalization_id" IS NOT NULL;--> statement-breakpoint
UPDATE `invitations`
   SET `email` = lower(trim(`email`)),
       `updated_at` = CAST(strftime('%s', 'now') AS integer) * 1000
 WHERE `status` IN ('pending', 'claim_verified')
   AND `email` <> lower(trim(`email`));--> statement-breakpoint
UPDATE `invitations` AS `duplicate`
   SET `status` = 'revoked',
       `updated_at` = CAST(strftime('%s', 'now') AS integer) * 1000
 WHERE `duplicate`.`status` IN ('pending', 'claim_verified')
   AND EXISTS (
     SELECT 1
       FROM `invitations` AS `keeper`
      WHERE `keeper`.`tenant_id` = `duplicate`.`tenant_id`
        AND `keeper`.`org_id` = `duplicate`.`org_id`
        AND `keeper`.`email` = `duplicate`.`email`
        AND `keeper`.`status` IN ('pending', 'claim_verified')
        AND (
          `keeper`.`created_at` > `duplicate`.`created_at`
          OR (
            `keeper`.`created_at` = `duplicate`.`created_at`
            AND `keeper`.`id` > `duplicate`.`id`
          )
        )
   );--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_tenant_org_email_pending_unq` ON `invitations` (`tenant_id`,`org_id`,`email`) WHERE "invitations"."status" IN ('pending', 'claim_verified');
