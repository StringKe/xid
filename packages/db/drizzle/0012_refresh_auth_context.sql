ALTER TABLE `refresh_tokens` ADD `auth_time` integer;--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD `acr` text;--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD `amr` text;
