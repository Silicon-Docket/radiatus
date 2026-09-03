import type { GraphEnv } from './graph';
import type { StripeEnv } from './stripe';

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
 * The routes that need one of these narrow `Env` through the type predicates
 * below, so the clients in stripe.ts and graph.ts are unreachable on an
 * unconfigured deployment — the compiler enforces the fail-closed behaviour
 * rather than trusting it.
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

// Every one of these must be present before /api/mail/lookup or the scheduled
// poll will call Graph. GRAPH_MAILBOX is the single mailbox the integration is
// allowed to read; there is deliberately no request parameter that can change it.
const GRAPH_ENV_KEYS = ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'GRAPH_MAILBOX'] as const;

/**
 * A type predicate, not a plain boolean: past this check the compiler knows the
 * Graph credentials are strings, which is what makes listCorrespondence and
 * listRecentMessages uncallable on an unconfigured deployment rather than
 * merely unreached.
 *
 * These live here, beside `Env`, rather than in worker.ts because flagging.ts
 * needs the Stripe one too and worker.ts imports flagging.ts. The imports above
 * are type-only, so nothing about that arrangement survives to runtime.
 */
export function isGraphConfigured(env: Env): env is Env & GraphEnv {
  return GRAPH_ENV_KEYS.every((key) => Boolean(env[key]));
}

/** Same idea for Stripe: narrowing here is what lets lookupStripeRecord require the key. */
export function isStripeConfigured(env: Env): env is Env & StripeEnv {
  return Boolean(env.STRIPE_SECRET_KEY);
}
