/**
 * Rules that decide which support-mailbox messages flag an account.
 *
 * WHAT A RULE CAN SEE: metadata only — the shaped message from src/graph.js,
 * which is `{ id, subject, from, toRecipients, receivedDateTime, webLink,
 * conversationId, hasAttachments }`. In practice that means the SUBJECT and the
 * SENDER ADDRESS.
 *
 * WHAT A RULE CANNOT SEE: the message body. Not `body`, not `bodyPreview`, not
 * "just the first line". This is not an oversight to be patched: the Exchange
 * `Application Mail.ReadBasic` grant this integration asks for does not include
 * message content at all, so the body is never in the object to begin with.
 * Reaching it would mean upgrading the grant to `Mail.Read`, at which point a
 * leaked ADMIN_API_TOKEN could read every message in the mailbox — a far worse
 * trade than a rule that occasionally misses. A rule that needs body text
 * cannot be expressed here, deliberately.
 *
 * DISABLING FLAGGING: export an empty array. The poll still runs, still records
 * what it has seen, and never flags anything. Nothing else needs changing.
 *
 * Each rule is `{ id, description, matches(message) }`. `matches` returns
 * truthy to flag; `id` is stored as the account's `flag_reason`. A rule that
 * throws is caught and skipped by the caller, so a typo in one regex cannot
 * stop the whole run — but it also means a broken rule fails silently, so test
 * yours.
 */

/**
 * ===========================================================================
 * THIS IS AN EXAMPLE. REPLACE IT.
 * ===========================================================================
 *
 * It exists so the feature has something to demonstrate on a fresh clone, not
 * because "refund" is the right trigger for your business. Delete it, or swap
 * the pattern, before this reaches anyone's real support mailbox.
 *
 * WORD-BOUNDARY BEHAVIOUR — a deliberate choice, not a side effect:
 *
 *   /\brefund\b/i matches the standalone word only.
 *     matches:  "refund", "Refund request", "Re: refund", "refund-status",
 *               "(refund)", "REFUND"
 *     does NOT: "refunds", "refunded", "refunding", "refundable",
 *               "non-refundable", "prefund"
 *
 *   The trailing \b needs a non-word character after "refund"; in "refunds" it
 *   gets "s", so the match fails outright — the regex does not match the
 *   "refund" prefix inside a longer word.
 *
 * We keep the narrow form on purpose. "non-refundable" is boilerplate that
 * turns up in ordinary billing and marketing subject lines, and a queue that
 * flags those is a queue operators learn to ignore — which costs more than the
 * genuine "I was refunded twice" that slips past. A missed flag still leaves
 * the message sitting in the mailbox where a human will read it; a noisy flag
 * degrades the whole feature.
 *
 * To match the word family instead, widen the pattern deliberately:
 *   /\brefund(s|ed|ing|able)?\b/i     — includes "non-refundable"
 *   /\brefund(s|ed|ing)?\b/i          — the verb forms, not the adjective
 */
const REFUND_EXAMPLE_RULE = {
  id: 'refund-mention',
  description: 'EXAMPLE — subject contains the word "refund" (not "refunds"/"refunded"). Replace me.',
  matches(message) {
    return /\brefund\b/i.test(message.subject || '');
  },
};

export const FLAG_RULES = [REFUND_EXAMPLE_RULE];
