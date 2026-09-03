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

/**
 * One row per email address that auto-flagging has flagged at least once.
 *
 * Rows are created on a rule match, not for every sender seen: clearing a flag
 * keeps the row (see `POST /api/accounts/resolve`), which is what makes the
 * "all accounts" view mean "everything that has ever been flagged" rather than
 * "everyone who has ever emailed support".
 *
 * `email` is the primary key and is stored LOWERCASED. SQLite text comparison
 * is case-sensitive by default, so `Ada@Example.com` and `ada@example.com`
 * would otherwise be two accounts. Nothing in the database enforces the casing
 * — every write path in src/ lowercases before binding, and the tests assert it.
 */
export const accounts = sqliteTable(
  'accounts',
  {
    email: text('email').primaryKey(),
    // Null when the sender is not a known Stripe customer, or when the Stripe
    // lookup failed during the poll. The signal is worth keeping either way.
    stripeCustomerId: text('stripe_customer_id'),
    flagged: integer('flagged').notNull().default(0),
    // The id of the rule that fired, and the subject that tripped it, so an
    // operator can see why an account is flagged without opening Outlook.
    flagReason: text('flag_reason'),
    flagSubject: text('flag_subject'),
    lastFlaggedAt: text('last_flagged_at'),
    firstSeenAt: text('first_seen_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index('idx_accounts_flagged').on(table.flagged, table.lastFlaggedAt)]
);

/**
 * Every message the poller has already examined, matched or not.
 *
 * This table does double duty and the two jobs are deliberately coupled:
 *
 * 1. Idempotency. A message id present here is skipped, so a retried or
 *    overlapping run cannot double-flag — and, more importantly, cannot
 *    resurrect a flag an operator just cleared.
 * 2. The watermark. The next poll asks Graph for messages at or after
 *    MAX(received_at); there is no separate cursor row to fall out of step
 *    with what was actually processed, and a run that dies half way resumes
 *    from the last message it recorded rather than replaying the batch.
 *
 * DO NOT add a retention sweep that deletes old rows. Pruning would roll the
 * watermark backwards to the oldest surviving row AND forget that those
 * messages were already handled, which together re-flag accounts whose flags
 * were cleared. If this table ever needs bounding, the watermark has to move
 * somewhere else first.
 */
export const processedMessages = sqliteTable(
  'processed_messages',
  {
    messageId: text('message_id').primaryKey(),
    // The message's own receivedDateTime (ISO 8601 from Graph), not the time we
    // looked at it — this is the column the watermark is read from.
    receivedAt: text('received_at').notNull(),
    processedAt: text('processed_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index('idx_processed_messages_received').on(table.receivedAt)]
);
