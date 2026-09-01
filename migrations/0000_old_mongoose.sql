CREATE TABLE `subscription_admin_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`stripe_subscription_id` text NOT NULL,
	`entry_key` text NOT NULL,
	`entry_value` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_subscription_admin_entries_subscription` ON `subscription_admin_entries` (`stripe_subscription_id`);--> statement-breakpoint
CREATE INDEX `idx_subscription_admin_entries_customer` ON `subscription_admin_entries` (`stripe_customer_id`);