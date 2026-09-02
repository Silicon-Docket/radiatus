/**
 * The Worker's bindings and secrets: `DB` comes from wrangler.toml, the rest
 * from `wrangler secret put` (or `.dev.vars` locally).
 *
 * The optionality here is meaningful, not defensive. `DB` and `ADMIN_API_TOKEN`
 * are always present — the Worker cannot serve a single `/api/*` request
 * without them. Everything else is a feature that ships switched off: the
 * Stripe lookup answers 500 without `STRIPE_SECRET_KEY`, and the Office 365
 * correspondence panel answers 501 unless all four `GRAPH_*` variables are set.
 * Typing those as `string` would state that a default deployment has them,
 * which is exactly backwards.
 *
 * The routes that need one of these narrow `Env` through a type predicate
 * (see `isStripeConfigured` / `isGraphConfigured` in worker.ts), so the clients
 * in stripe.ts and graph.ts are unreachable on an unconfigured deployment —
 * the compiler enforces the fail-closed behaviour rather than trusting it.
 */
export interface Env {
  DB: D1Database;
  ADMIN_API_TOKEN: string;
  STRIPE_SECRET_KEY?: string;
  GRAPH_TENANT_ID?: string;
  GRAPH_CLIENT_ID?: string;
  GRAPH_CLIENT_SECRET?: string;
  GRAPH_MAILBOX?: string;
}
