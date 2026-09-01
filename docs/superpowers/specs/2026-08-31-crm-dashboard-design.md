# Radiatus CRM dashboard — design

## Summary

Rebrand radiatus from "an admin template for Stripe subscription records" to what it's actually for: an open-source CRM connecting Stripe and Cloudflare. The `/admin` page changes from a generic key/value CRUD list into a subscription troubleshooting tool — look up a customer by email, customer ID, or subscription ID, and see their real Stripe state (status, billing period, payment method, recent invoices/payments) alongside internal notes.

## Motivation

Today, `/admin` only shows whatever's been manually written into `subscription_admin_entries` — arbitrary key/value pairs a human typed in. It has no connection to a subscription's actual state in Stripe, so it can't answer the question it exists for: "why is this user having a problem with their subscription?" Answering that requires the real data — status, billing period, payment method, payment history — which only Stripe has.

## Non-goals

- Not a replacement for Stripe's own dashboard. No billing actions (refund, cancel, change plan) in v1 — this is read-only troubleshooting plus notes.
- Not adding a second auth mechanism. The existing shared `ADMIN_API_TOKEN` gate extends to the new endpoints; it isn't replaced.
- Not adding a frontend framework or a build step. The admin page stays a single HTML/JS template string served by the Worker, consistent with the rest of the template.

## Approach

Two ways to talk to Stripe from the Worker were considered:

1. **Plain `fetch()` against Stripe's REST API** (recommended). `Authorization: Bearer <STRIPE_SECRET_KEY>` against `https://api.stripe.com/v1/...`. No new dependency; matches how `src/worker.js` already talks to D1 — direct, readable, nothing to configure.
2. **The official `stripe` npm SDK**, using its fetch-based HTTP client (the supported way to use it on Workers). Less code per call, but it would be the first runtime dependency this template carries, for a handful of read-only GET calls that don't need an SDK's full surface.

Going with (1).

## Architecture

### Stripe integration

- New Worker secret: `STRIPE_SECRET_KEY`.
- One new endpoint, not several granular ones — it matches the one view the UI actually needs:

  ```
  GET /api/stripe/lookup?q=<query>
  ```

  Dispatches on the shape of `q`:
  - starts with `cus_` → treat as a Stripe customer ID
  - starts with `sub_` → treat as a Stripe subscription ID
  - otherwise → treat as an email address, look up the customer by email

  Returns a combined shape: the customer, their subscription(s) (status, current period start/end, plan), default payment method (brand + last 4 only — never full card details), and recent invoices (amount, status, paid/failed, date).
- Falls under the existing `/api/*` prefix, so it's covered by the current `isAuthorized()` token check without new gating logic.

### The D1 table's new role

- `subscription_admin_entries` keeps its exact current shape and its existing `/api/entries` CRUD endpoints — nothing about the table or those routes changes.
- What changes is how the admin page presents it: instead of being the whole page, it becomes the "notes" section attached to whatever customer/subscription was just looked up via `/api/stripe/lookup`.

### Admin page

- A search box (email, customer ID, or subscription ID) replaces the current top-level entry list as the page's entry point.
- A result view renders: status badge, billing period, customer name/email, payment method, a short invoice/payment history list.
- The existing create/edit/delete notes UI renders beneath the result, scoped to the looked-up `stripe_customer_id`/`stripe_subscription_id`.
- Same implementation pattern as today: one `ADMIN_HTML` template string in `src/worker.js`, vanilla `fetch`/DOM calls, no build step.

### Error handling

- Stripe "not found" (customer/subscription doesn't exist) is distinct from "not found" on the D1 side — surfaced as a clear, specific message, not a generic error.
- A Stripe API error (bad/expired key, rate limit) returns a 502 with a message that says the failure was on Stripe's side, not silently rendered as "no results."
- `STRIPE_SECRET_KEY` is never logged and never echoed back in any response body, including error messages.

### Rebrand

- `package.json` `description`, the README's H1 subtitle and "Key features" framing move from "admin surface over Stripe subscriptions" to "an open-source CRM connecting Stripe and Cloudflare."
- The logo doesn't change — it was designed as an abstract mark, not tied to "admin template" wording specifically.
- GitHub repo description field gets the same updated one-liner (asked about separately at implementation time, since it's a repo-settings change, not a file in the repo).

### Testing

- `test/worker.test.js` mocks Stripe's responses (stub `fetch`, same style the existing tests already use for pure functions) rather than requiring a live `STRIPE_SECRET_KEY` in CI. Covers: successful lookup by each of the three query shapes, not-found, and a Stripe-side error response.
- No live Stripe credentials touch CI.

## Security

- `STRIPE_SECRET_KEY` follows the same handling as `ADMIN_API_TOKEN`: `wrangler secret put` for the deployed Worker, `.dev.vars` for local dev, never committed.
- The README's existing security note (the `/admin` page itself is reachable without a token; the token gates writes/reads through `/api/*`) still applies and now covers real customer data, so it's worth re-emphasizing there rather than treating it as old news.
- Payment method details returned from Stripe are limited to brand + last 4 digits — never full card numbers (Stripe's API doesn't return full numbers anyway, but the response shape should make the intent explicit rather than passing through whatever Stripe sends).

## Open questions

None outstanding — data source, the D1 table's new role, and lookup scope were confirmed directly; testing strategy (mocked, not live) was a default the reviewer can override.
