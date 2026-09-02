import { listRecentMessages, type GraphEnv, type ShapedMessage } from './graph';
import { findCustomerByEmail, type StripeCustomer, type StripeEnv } from './stripe';
import { FLAG_RULES, type FlagRule } from './flag-rules';
import { isStripeConfigured, type Env } from './types';

/**
 * How far back the very first poll looks, before processed_messages has a
 * watermark to read. Deliberately short: a fresh deployment should start
 * flagging what arrives from now on, not retroactively raise a queue out of
 * however many months of mailbox history the tenant happens to hold.
 */
const INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * What a poll needs: D1, plus Graph credentials the caller has already checked.
 * `Env & GraphEnv` is exactly what `isGraphConfigured` narrows to, so the
 * scheduled handler cannot reach this function without them.
 */
export type PollEnv = Env & GraphEnv;

/**
 * Seams for the tests, so the logic can be driven without stubbing global
 * fetch. Each defaults to the real thing.
 */
export interface PollDeps {
  rules?: FlagRule[];
  listMessages?: (env: GraphEnv, sinceIso: string) => Promise<ShapedMessage[]>;
  lookupCustomer?: (env: StripeEnv, email: string) => Promise<StripeCustomer | null>;
  now?: () => Date;
}

/** The assertable result of one pass, and something worth logging. */
export interface PollSummary {
  fetched: number;
  skipped: number;
  processed: number;
  flagged: number;
}

interface FlaggedAccountWrite {
  email: string;
  stripeCustomerId: string | null;
  flagReason: string;
  flagSubject: string | null;
  flaggedAt: string;
}

/**
 * Returns the first rule that matches, or null.
 *
 * Rules are developer-supplied code running on a schedule with no operator
 * watching. One that throws is skipped rather than allowed to abort the poll:
 * a typo in a single regex would otherwise stop every other rule from ever
 * firing. Nothing is logged because a Worker's scheduled handler has no logger
 * an adopter would routinely read — which is exactly why src/flag-rules.ts
 * tells them to test their rules.
 */
export function evaluateRules(message: ShapedMessage, rules: FlagRule[]): FlagRule | null {
  for (const rule of rules) {
    try {
      if (rule.matches(message)) return rule;
    } catch {
      // Intentionally swallowed; see above.
    }
  }
  return null;
}

function readWatermark(db: D1Database): Promise<{ watermark: string | null } | null> {
  return db
    .prepare('SELECT MAX(received_at) AS watermark FROM processed_messages')
    .first<{ watermark: string | null }>();
}

function findProcessedMessage(db: D1Database, messageId: string): Promise<{ message_id: string } | null> {
  return db
    .prepare('SELECT message_id FROM processed_messages WHERE message_id = ?1')
    .bind(messageId)
    .first<{ message_id: string }>();
}

function recordProcessedMessage(db: D1Database, messageId: string, receivedAt: string): Promise<D1Response> {
  // OR IGNORE so a message that appears twice in one batch — or a run racing
  // another — is a no-op rather than a constraint error that kills the poll.
  return db
    .prepare('INSERT OR IGNORE INTO processed_messages (message_id, received_at) VALUES (?1, ?2)')
    .bind(messageId, receivedAt)
    .run();
}

/**
 * Upserts the account as flagged.
 *
 * Two things the ON CONFLICT branch deliberately does NOT do:
 * - it never overwrites first_seen_at, so the "known since" column survives
 *   every re-flag;
 * - it never nulls out a stripe_customer_id that a previous run resolved. A
 *   Stripe lookup that fails today should not erase what worked yesterday,
 *   hence COALESCE(excluded.…, accounts.…) rather than a plain assignment.
 *
 * flaggedAt is bound explicitly rather than left to the column's
 * CURRENT_TIMESTAMP default: the default writes SQLite's 'YYYY-MM-DD HH:MM:SS'
 * form, and mixing that with ISO 8601 in the same column would break the
 * string ordering the accounts list sorts on.
 */
function upsertFlaggedAccount(
  db: D1Database,
  { email, stripeCustomerId, flagReason, flagSubject, flaggedAt }: FlaggedAccountWrite
): Promise<D1Response> {
  return db
    .prepare(
      `INSERT INTO accounts
        (email, stripe_customer_id, flagged, flag_reason, flag_subject, last_flagged_at, first_seen_at)
       VALUES (?1, ?2, 1, ?3, ?4, ?5, ?5)
       ON CONFLICT(email) DO UPDATE SET
         stripe_customer_id = COALESCE(excluded.stripe_customer_id, accounts.stripe_customer_id),
         flagged = 1,
         flag_reason = excluded.flag_reason,
         flag_subject = excluded.flag_subject,
         last_flagged_at = excluded.last_flagged_at`
    )
    .bind(email, stripeCustomerId, flagReason, flagSubject, flaggedAt)
    .run();
}

/**
 * One polling pass: fetch what is new, flag what matches, remember what was
 * seen. Called by the Worker's scheduled handler, which has already checked
 * that Graph is configured.
 */
export async function pollAndFlag(env: PollEnv, deps: PollDeps = {}): Promise<PollSummary> {
  const {
    rules = FLAG_RULES,
    listMessages = listRecentMessages,
    lookupCustomer = findCustomerByEmail,
    now = () => new Date(),
  } = deps;

  const db = env.DB;
  const watermarkRow = await readWatermark(db);
  const since = watermarkRow?.watermark || new Date(now().getTime() - INITIAL_LOOKBACK_MS).toISOString();

  const messages = await listMessages(env, since);
  const summary: PollSummary = { fetched: messages.length, skipped: 0, processed: 0, flagged: 0 };

  for (const message of messages) {
    // Without an id there is no idempotency key, and without a receivedDateTime
    // there is nothing to advance the watermark by. Neither should be possible
    // — both are in $select and one is the sort key — so drop the message
    // rather than write a row that corrupts the watermark for every later run.
    if (!message.id || !message.receivedDateTime) continue;

    if (await findProcessedMessage(db, message.id)) {
      summary.skipped += 1;
      continue;
    }

    const rule = evaluateRules(message, rules);
    const sender = (message.from?.address || '').trim().toLowerCase();

    // Never flag the support mailbox on its own outgoing mail. listRecentMessages
    // already scopes to the Inbox, which should keep Sent Items out — but that
    // scoping is unverified against a live tenant, and the failure it guards
    // against is bad enough to warrant two independent defences: every reply the
    // team sends ("Re: refund request") would otherwise self-flag the mailbox and
    // pin it to the top of the queue forever.
    const isOwnMailbox = sender === (env.GRAPH_MAILBOX || '').trim().toLowerCase();

    // A matched message with no sender address has nothing to flag: accounts
    // are keyed by email. It is still recorded below so the run moves on.
    if (rule && sender && !isOwnMailbox) {
      let stripeCustomerId: string | null = null;
      // No key configured means no Stripe to ask; skipping saves a round trip
      // per flagged message that could only ever come back 401. The predicate
      // is also what narrows `env` to something lookupCustomer will accept.
      if (isStripeConfigured(env)) {
        try {
          const customer = await lookupCustomer(env, sender);
          stripeCustomerId = customer?.id || null;
        } catch {
          // Stripe being down must not abort the poll or lose the flag. Record
          // the account with a null customer id; the next flag re-resolves it.
        }
      }

      await upsertFlaggedAccount(db, {
        email: sender,
        stripeCustomerId,
        flagReason: rule.id,
        flagSubject: message.subject || null,
        // The customer's own arrival time, not this cron tick: it puts the
        // list in the order an operator triages, and stops a backlog poll
        // collapsing every flag onto one indistinguishable timestamp.
        flaggedAt: message.receivedDateTime,
      });
      summary.flagged += 1;
    }

    // Last, so a crash between flagging and recording replays the message on
    // the next run (harmless — the upsert is idempotent) instead of losing it.
    await recordProcessedMessage(db, message.id, message.receivedDateTime);
    summary.processed += 1;
  }

  return summary;
}
