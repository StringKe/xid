UPDATE `users`
SET
  `primary_email_id` = (
    SELECT `user_emails`.`id`
    FROM `user_emails`
    WHERE `user_emails`.`tenant_id` = `users`.`tenant_id`
      AND `user_emails`.`user_id` = `users`.`id`
      AND `user_emails`.`is_primary` = 1
    ORDER BY `user_emails`.`created_at` ASC
    LIMIT 1
  ),
  `updated_at` = unixepoch('subsec') * 1000
WHERE `primary_email_id` IS NULL
  AND EXISTS (
    SELECT 1
    FROM `user_emails`
    WHERE `user_emails`.`tenant_id` = `users`.`tenant_id`
      AND `user_emails`.`user_id` = `users`.`id`
      AND `user_emails`.`is_primary` = 1
  );
