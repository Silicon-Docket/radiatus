// Drizzle schema for D1 — this is the source of truth for the table shape.
// Edit this file, then run `npm run db:generate` to produce a migration.
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const subscriptionAdminEntries = sqliteTable(
  'subscription_admin_entries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    stripeCustomerId: text('stripe_customer_id').notNull(),
    stripeSubscriptionId: text('stripe_subscription_id').notNull(),
    entryKey: text('entry_key').notNull(),
    entryValue: text('entry_value').notNull().default(''),
    // Stored as SQLite TEXT via CURRENT_TIMESTAMP, matching the original hand-written schema.
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('idx_subscription_admin_entries_subscription').on(table.stripeSubscriptionId),
    index('idx_subscription_admin_entries_customer').on(table.stripeCustomerId),
  ]
);
