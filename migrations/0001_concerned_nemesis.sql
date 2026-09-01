CREATE TABLE `accounts` (
	`email` text PRIMARY KEY NOT NULL,
	`stripe_customer_id` text,
	`flagged` integer DEFAULT 0 NOT NULL,
	`flag_reason` text,
	`flag_subject` text,
	`last_flagged_at` text,
	`first_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_accounts_flagged` ON `accounts` (`flagged`,`last_flagged_at`);--> statement-breakpoint
CREATE TABLE `processed_messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`received_at` text NOT NULL,
	`processed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_processed_messages_received` ON `processed_messages` (`received_at`);