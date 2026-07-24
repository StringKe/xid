-- authorization_codes / refresh_tokens 加 session_id:打通 hosted session -> code -> token 的 sid 链路
-- (03 章 9.1,ID token sid 来源)。可空:非 session 链路(client_credentials / token-exchange / device)留空。
ALTER TABLE `authorization_codes` ADD `session_id` text;
--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD `session_id` text;
