# Auto-flagging accounts from support mail — design

## Summary

When a customer emails the designated support mailbox, their account is
automatically flagged for review. The admin page gains an Accounts menu:
searchable, listing every account the system knows about, with a
"flagged only" filter that is **on by default**. Which messages flag an
account is decided by developer-editable rules in source; none are active by
default beyond one worked example (subject containing "refund").

## The constraint that shapes this

The Graph integration deliberately fetches **metadata only** — subjects,
participants, dates — because message-body exclusion is enforced by the
Exchange `Application Mail.ReadBasic` grant rather than by our code. That is
the property that makes a mail integration defensible behind a single shared
`ADMIN_API_TOKEN`.

Consequently **rules match on subject and sender address, not body text.**
Matching body content would require widening the grant to `Mail.Read`, which
would mean a leaked admin token could read message contents. That trade is
not worth automatic flagging, so it is refused. This is documented for
adopters rather than hidden: a rule that needs body text cannot be expressed,
by design.

## What runs the automation

A Cloudflare **Cron Trigger** (`scheduled` handler), not Graph change
notifications. Webhooks would need a publicly reachable endpoint, subscription
creation, and renewal every few days — lifecycle machinery disproportionate to
a template. Polling is simple, stateless between runs apart from a watermark,
and degrades to "flags appear a few minutes late".

Each run:
1. No-op immediately if Graph is not configured. Most adopters never set this
   up and their Worker must not error on a schedule.
2. Read the watermark (last processed `receivedDateTime`).
3. Fetch messages in `GRAPH_MAILBOX` newer than the watermark, oldest first.
4. For each message, evaluate the rules against subject + sender.
5. On a match, upsert the sender's account as flagged, recording which rule
   fired and the subject that triggered it.
6. Advance the watermark.

Idempotency is by Graph `message_id`: a message already processed is skipped,
so an overlapping or retried run cannot double-flag or resurrect a flag an
operator just cleared.

## Data model

Two new tables. `subscription_admin_entries` is untouched.

`accounts` — one row per email address the system has seen:
- `email` (PK, lowercased on write — the existing Stripe lookup already
  learned this lesson about casing)
- `stripe_customer_id` (nullable; resolved via the existing
  `findCustomerByEmail` when possible, null when the sender isn't a known
  Stripe customer — we still record them rather than dropping the signal)
- `flagged` (integer 0/1)
- `flag_reason` (nullable; the id of the rule that fired)
- `flag_subject` (nullable; the subject that triggered it, so an operator can
  see why without opening Outlook)
- `last_flagged_at`, `first_seen_at`

`processed_messages` — `message_id` (PK) plus `processed_at`. Idempotency only.

## Rules

`src/flag-rules.js` exports `FLAG_RULES`, an array of
`{ id, description, matches(message) }` where `message` is the shaped
metadata object (`subject`, `from`, `toRecipients`, `receivedDateTime`, …).

Ships with exactly one rule, clearly marked as an example to replace:
subject matching `/\brefund\b/i` → flag with reason `refund-mention`.

An empty array disables flagging entirely while leaving the polling harmless.
A rule that throws is caught and skipped so one bad regex cannot stop the
whole run.

## API

All behind the existing `ADMIN_API_TOKEN` gate.

- `GET /api/accounts?q=<search>&flaggedOnly=<bool>` — list accounts, newest
  flags first. `q` matches email or stripe customer id (case-insensitive,
  substring). `flaggedOnly` defaults to **true** when the parameter is absent,
  matching the UI default.
- `POST /api/accounts/resolve` `{ email }` — clear a flag (sets `flagged=0`,
  keeps the row and its history). Not a delete: the account stays listed so
  "all accounts" means something.

## UI

An "Accounts" section in `ADMIN_HTML`, above the existing customer search:
- a search box,
- a **"Show flagged only" checkbox, checked on load**,
- a table of email / Stripe customer / flag reason / triggering subject /
  when, with a "Clear flag" button per flagged row,
- clicking an account fills the existing customer search box, so the flag is a
  route into the troubleshooting view rather than a dead end.

Loads on page load (unlike the correspondence panel, which is per-customer and
click-loaded) — the flagged queue is the reason an operator opens this page.

## Testing

`node --test`, `globalThis.fetch` stubbed, and a fake D1 binding (the repo has
no D1 test double yet; this adds a small one). Cover:
- the example refund rule matches a "Re: refund request" subject and does not
  match unrelated subjects,
- word-boundary behaviour: "refunded" should be considered — the rule uses
  `\b` so decide and assert the chosen semantics explicitly,
- a message already in `processed_messages` does not re-flag,
- clearing a flag then re-running the poll over the same message leaves it
  cleared,
- `flaggedOnly` defaults to true when the query parameter is absent,
- the scheduled handler no-ops without Graph configuration.

## Out of scope

Per-operator identity, flag assignment/ownership, notifications, and body-text
matching. The first three are features; the last is a deliberate refusal.
