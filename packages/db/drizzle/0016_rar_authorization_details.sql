ALTER TABLE `authorization_codes` ADD `authorization_details` text;
ALTER TABLE `refresh_tokens` ADD `authorization_details` text;
