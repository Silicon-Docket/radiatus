CREATE TABLE IF NOT EXISTS subscription_admin_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  entry_value TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_subscription_admin_entries_subscription
  ON subscription_admin_entries (stripe_subscription_id);

CREATE INDEX IF NOT EXISTS idx_subscription_admin_entries_customer
  ON subscription_admin_entries (stripe_customer_id);
