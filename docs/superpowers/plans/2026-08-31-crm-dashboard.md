# CRM Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/admin` from a generic key/value CRUD list into a search-first CRM: look up a customer by email or Stripe ID, see their live status/billing/payment history from Stripe, and attach notes — and rebrand the project's copy to match.

**Architecture:** A new `src/stripe.js` module talks to Stripe's REST API via plain `fetch` and shapes the response; `src/worker.js` gains one new authenticated route, `GET /api/stripe/lookup`, that calls it; `ADMIN_HTML` is redesigned around a search box whose result scopes the existing notes CRUD to a specific customer/subscription instead of listing all of them.

**Tech Stack:** Plain ESM JavaScript (no TypeScript, no build step, no new runtime dependency), Cloudflare Workers + D1, Node's built-in `node:test` runner with `globalThis.fetch` stubbing for tests (no mocking library).

**Spec:** [docs/superpowers/specs/2026-08-31-crm-dashboard-design.md](../specs/2026-08-31-crm-dashboard-design.md)

## Global Constraints

- No new runtime npm dependency for the Stripe integration — plain `fetch`, not the `stripe` SDK.
- No frontend framework or build step — `ADMIN_HTML` stays a single template string.
- Read-only in v1 — no Stripe writes (refund, cancel, plan change).
- The existing `ADMIN_API_TOKEN` gate covers the new endpoint; no second auth mechanism.
- `STRIPE_SECRET_KEY` is never logged and never appears in a response body.
- Payment method data returned to the client is limited to `{brand, last4}` — nothing closer to a full card number.
- Tests mock Stripe's HTTP responses; no live `STRIPE_SECRET_KEY` in CI.
- Rebrand copy converges on: "an open-source CRM connecting Stripe and Cloudflare."

---

### Task 1: Stripe API client module

**Files:**
- Create: `src/stripe.js`
- Test: `test/stripe.test.js`

**Interfaces:**
- Consumes: nothing from this codebase; calls the real Stripe REST API at `https://api.stripe.com/v1` via global `fetch`.
- Produces (used by Task 2): `classifyQuery(rawQuery: string): {type: 'customer'|'subscription'|'email', value: string}`, `class StripeApiError extends Error { status: number }`, `async lookupStripeRecord(env: {STRIPE_SECRET_KEY: string}, rawQuery: string): Promise<{found: false} | {found: true, customer: {id, email, name}, paymentMethod: {brand, last4}|null, subscriptions: Array<{id, status, currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd}>, invoices: Array<{id, status, amountDue, amountPaid, currency, created, hostedInvoiceUrl}>}>`.

- [ ] **Step 1: Write the failing tests**

Create `test/stripe.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyQuery,
  StripeApiError,
  findCustomerByEmail,
  getCustomer,
  shapeSubscription,
  shapeInvoice,
  shapePaymentMethod,
  lookupStripeRecord,
} from '../src/stripe.js';

const ENV = { STRIPE_SECRET_KEY: 'sk_test_123' };
const originalFetch = globalThis.fetch;

test('classifyQuery detects customer, subscription, and email shapes', () => {
  assert.deepEqual(classifyQuery('cus_abc'), { type: 'customer', value: 'cus_abc' });
  assert.deepEqual(classifyQuery('sub_abc'), { type: 'subscription', value: 'sub_abc' });
  assert.deepEqual(classifyQuery('  person@example.com  '), { type: 'email', value: 'person@example.com' });
});

test('getCustomer returns null on a 404 from Stripe', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'No such customer' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  try {
    const customer = await getCustomer(ENV, 'cus_missing');
    assert.equal(customer, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getCustomer throws StripeApiError on a non-404 failure', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  try {
    await assert.rejects(() => getCustomer(ENV, 'cus_x'), StripeApiError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('findCustomerByEmail sends the email as a query param and returns the first match', async () => {
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/v1/customers');
    assert.equal(parsed.searchParams.get('email'), 'person@example.com');
    return new Response(JSON.stringify({ data: [{ id: 'cus_1', email: 'person@example.com' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const customer = await findCustomerByEmail(ENV, 'person@example.com');
    assert.equal(customer.id, 'cus_1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('findCustomerByEmail returns null when Stripe has no match', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const customer = await findCustomerByEmail(ENV, 'nobody@example.com');
    assert.equal(customer, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('shapeSubscription trims a Stripe subscription to the fields the UI needs', () => {
  const shaped = shapeSubscription({
    id: 'sub_1',
    status: 'active',
    current_period_start: 1000,
    current_period_end: 2000,
    cancel_at_period_end: false,
    latest_invoice: 'in_should_be_dropped',
  });
  assert.deepEqual(shaped, {
    id: 'sub_1',
    status: 'active',
    currentPeriodStart: 1000,
    currentPeriodEnd: 2000,
    cancelAtPeriodEnd: false,
  });
});

test('shapeInvoice trims a Stripe invoice to the fields the UI needs', () => {
  const shaped = shapeInvoice({
    id: 'in_1',
    status: 'paid',
    amount_due: 500,
    amount_paid: 500,
    currency: 'usd',
    created: 1700000000,
    hosted_invoice_url: 'https://stripe.example/invoice',
  });
  assert.deepEqual(shaped, {
    id: 'in_1',
    status: 'paid',
    amountDue: 500,
    amountPaid: 500,
    currency: 'usd',
    created: 1700000000,
    hostedInvoiceUrl: 'https://stripe.example/invoice',
  });
});

test('shapePaymentMethod returns brand/last4 only, or null', () => {
  assert.deepEqual(shapePaymentMethod({ card: { brand: 'visa', last4: '4242', exp_year: 2030 } }), {
    brand: 'visa',
    last4: '4242',
  });
  assert.equal(shapePaymentMethod(null), null);
  assert.equal(shapePaymentMethod({}), null);
});

test('lookupStripeRecord returns found:false for an unknown email', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const result = await lookupStripeRecord(ENV, 'nobody@example.com');
    assert.deepEqual(result, { found: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('lookupStripeRecord assembles customer, subscriptions, invoices, and payment method', async () => {
  globalThis.fetch = async (url) => {
    const { pathname } = new URL(url);
    if (pathname === '/v1/customers/cus_1') {
      return new Response(
        JSON.stringify({
          id: 'cus_1',
          email: 'person@example.com',
          name: 'Person Example',
          invoice_settings: { default_payment_method: 'pm_1' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (pathname === '/v1/subscriptions') {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'sub_1',
              status: 'active',
              current_period_start: 1,
              current_period_end: 2,
              cancel_at_period_end: false,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (pathname === '/v1/invoices') {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'in_1',
              status: 'paid',
              amount_due: 500,
              amount_paid: 500,
              currency: 'usd',
              created: 3,
              hosted_invoice_url: 'https://stripe.example/invoice',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (pathname === '/v1/payment_methods/pm_1') {
      return new Response(JSON.stringify({ id: 'pm_1', card: { brand: 'visa', last4: '4242' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('Unexpected fetch to ' + pathname);
  };
  try {
    const result = await lookupStripeRecord(ENV, 'cus_1');
    assert.equal(result.found, true);
    assert.equal(result.customer.email, 'person@example.com');
    assert.equal(result.subscriptions.length, 1);
    assert.equal(result.subscriptions[0].id, 'sub_1');
    assert.equal(result.invoices.length, 1);
    assert.deepEqual(result.paymentMethod, { brand: 'visa', last4: '4242' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('lookupStripeRecord surfaces a Stripe-side failure as StripeApiError', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'Rate limited' } }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
  try {
    await assert.rejects(() => lookupStripeRecord(ENV, 'cus_1'), StripeApiError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/stripe.test.js`
Expected: FAIL — `src/stripe.js` doesn't exist yet, so the import throws (`Cannot find module '../src/stripe.js'`).

- [ ] **Step 3: Write `src/stripe.js`**

```js
const STRIPE_API_BASE = 'https://api.stripe.com/v1';

export class StripeApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'StripeApiError';
    this.status = status;
  }
}

export function classifyQuery(rawQuery) {
  const value = (rawQuery || '').trim();
  if (value.startsWith('cus_')) return { type: 'customer', value };
  if (value.startsWith('sub_')) return { type: 'subscription', value };
  return { type: 'email', value };
}

async function stripeRequest(env, path, params = {}) {
  const url = new URL(STRIPE_API_BASE + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString(), {
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new StripeApiError(response.status, data.error?.message || 'Stripe API error');
  }
  return data;
}

async function stripeRequestOrNullOn404(env, path, params) {
  try {
    return await stripeRequest(env, path, params);
  } catch (error) {
    if (error instanceof StripeApiError && error.status === 404) return null;
    throw error;
  }
}

export async function findCustomerByEmail(env, email) {
  const result = await stripeRequest(env, '/customers', { email, limit: 1 });
  return result.data[0] || null;
}

export function getCustomer(env, customerId) {
  return stripeRequestOrNullOn404(env, `/customers/${customerId}`);
}

export function getSubscription(env, subscriptionId) {
  return stripeRequestOrNullOn404(env, `/subscriptions/${subscriptionId}`);
}

export function getPaymentMethod(env, paymentMethodId) {
  return stripeRequestOrNullOn404(env, `/payment_methods/${paymentMethodId}`);
}

export async function listSubscriptionsForCustomer(env, customerId) {
  const result = await stripeRequest(env, '/subscriptions', { customer: customerId, limit: 10 });
  return result.data;
}

export async function listInvoicesForCustomer(env, customerId) {
  const result = await stripeRequest(env, '/invoices', { customer: customerId, limit: 10 });
  return result.data;
}

export function shapeCustomer(customer) {
  return { id: customer.id, email: customer.email, name: customer.name };
}

export function shapeSubscription(subscription) {
  return {
    id: subscription.id,
    status: subscription.status,
    currentPeriodStart: subscription.current_period_start,
    currentPeriodEnd: subscription.current_period_end,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  };
}

export function shapeInvoice(invoice) {
  return {
    id: invoice.id,
    status: invoice.status,
    amountDue: invoice.amount_due,
    amountPaid: invoice.amount_paid,
    currency: invoice.currency,
    created: invoice.created,
    hostedInvoiceUrl: invoice.hosted_invoice_url,
  };
}

export function shapePaymentMethod(paymentMethod) {
  if (!paymentMethod || !paymentMethod.card) return null;
  return { brand: paymentMethod.card.brand, last4: paymentMethod.card.last4 };
}

export async function lookupStripeRecord(env, rawQuery) {
  const { type, value } = classifyQuery(rawQuery);
  if (!value) return { found: false };

  let customer;
  if (type === 'email') {
    customer = await findCustomerByEmail(env, value);
  } else if (type === 'customer') {
    customer = await getCustomer(env, value);
  } else {
    const subscription = await getSubscription(env, value);
    customer = subscription ? await getCustomer(env, subscription.customer) : null;
  }
  if (!customer) return { found: false };

  const [subscriptions, invoices] = await Promise.all([
    listSubscriptionsForCustomer(env, customer.id),
    listInvoicesForCustomer(env, customer.id),
  ]);

  let paymentMethod = null;
  const defaultPaymentMethodId = customer.invoice_settings?.default_payment_method;
  if (defaultPaymentMethodId) {
    paymentMethod = shapePaymentMethod(await getPaymentMethod(env, defaultPaymentMethodId));
  }

  return {
    found: true,
    customer: shapeCustomer(customer),
    paymentMethod,
    subscriptions: subscriptions.map(shapeSubscription),
    invoices: invoices.map(shapeInvoice),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/stripe.test.js`
Expected: PASS, all 11 tests.

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: PASS (oxlint is already scoped to `src test db drizzle.config.js`, which covers the new file).

- [ ] **Step 6: Commit**

```bash
git add src/stripe.js test/stripe.test.js
git commit -m "Add a Stripe REST API client for live customer/subscription lookups"
```

---

### Task 2: Wire `/api/stripe/lookup` into the Worker, and set up the secret

**Files:**
- Modify: `src/worker.js:1` (add import), `src/worker.js:338-342` (add route between the auth gate and the existing `/api/entries` GET handler)
- Modify: `test/worker.test.js` (extend the import, add route tests)
- Modify: `.dev.vars.example` (add `STRIPE_SECRET_KEY`)
- Modify: `AGENTS.md` (extend the secret-setup step)
- Modify: `README.md` (Quick start step 4, Security notes, API reference table)

**Interfaces:**
- Consumes: `classifyQuery`, `StripeApiError`, `lookupStripeRecord` from `src/stripe.js` (Task 1).
- Produces (used by Task 3): `GET /api/stripe/lookup?q=<query>` — `400` if `q` is missing, `401` if unauthorized (existing `isAuthorized` gate), `404` if Stripe has no match, `502` on a Stripe-side error, `200` with the `lookupStripeRecord` result body otherwise.

- [ ] **Step 1: Write the failing tests**

In `test/worker.test.js`, change the import line from:

```js
import { normalizeEntryPayload, validateEntryPayload } from '../src/worker.js';
```

to:

```js
import worker, { normalizeEntryPayload, validateEntryPayload } from '../src/worker.js';
```

Then append:

```js
test('/api/stripe/lookup requires q', async () => {
  const request = new Request('https://worker.example/api/stripe/lookup', {
    headers: { Authorization: 'Token secret' },
  });
  const response = await worker.fetch(request, { ADMIN_API_TOKEN: 'secret', STRIPE_SECRET_KEY: 'sk_test' });
  assert.equal(response.status, 400);
});

test('/api/stripe/lookup rejects an unauthorized request', async () => {
  const request = new Request('https://worker.example/api/stripe/lookup?q=cus_1');
  const response = await worker.fetch(request, { ADMIN_API_TOKEN: 'secret', STRIPE_SECRET_KEY: 'sk_test' });
  assert.equal(response.status, 401);
});

test('/api/stripe/lookup returns 404 when Stripe has no match', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const request = new Request('https://worker.example/api/stripe/lookup?q=nobody@example.com', {
      headers: { Authorization: 'Token secret' },
    });
    const response = await worker.fetch(request, { ADMIN_API_TOKEN: 'secret', STRIPE_SECRET_KEY: 'sk_test' });
    assert.equal(response.status, 404);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('/api/stripe/lookup returns 502 when Stripe errors', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'Rate limited' } }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
  try {
    const request = new Request('https://worker.example/api/stripe/lookup?q=cus_1', {
      headers: { Authorization: 'Token secret' },
    });
    const response = await worker.fetch(request, { ADMIN_API_TOKEN: 'secret', STRIPE_SECRET_KEY: 'sk_test' });
    assert.equal(response.status, 502);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/worker.test.js`
Expected: FAIL — the four new tests get a `404`/generic "Not found" from the router instead of the expected statuses, since the route doesn't exist yet (the `400` test in particular will fail because it currently falls through to the catch-all `json({ error: 'Not found' }, 404)`).

- [ ] **Step 3: Add the import and the route to `src/worker.js`**

At the very top of `src/worker.js` (before `export const ADMIN_HTML = ...`), add:

```js
import { lookupStripeRecord, StripeApiError } from './stripe.js';

```

Between the existing `isAuthorized` gate and the `/api/entries` GET handler (i.e. right after `return json({ error: 'Unauthorized. Send Authorization: Token <token>' }, 401); }` and before `if (url.pathname === '/api/entries' && request.method === 'GET') {`), insert:

```js
    if (url.pathname === '/api/stripe/lookup' && request.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) {
        return json({ error: 'q is required' }, 400);
      }
      try {
        const result = await lookupStripeRecord(env, q);
        if (!result.found) {
          return json({ error: 'Not found' }, 404);
        }
        return json(result);
      } catch (error) {
        if (error instanceof StripeApiError) {
          return json({ error: 'Stripe API error: ' + error.message }, 502);
        }
        throw error;
      }
    }

```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/worker.test.js`
Expected: PASS, all tests (the 3 original plus the 4 new ones).

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 6: Add the secret to `.dev.vars.example`**

Append to `.dev.vars.example`:

```
# Stripe secret key used by /api/stripe/lookup for live customer/subscription/invoice data.
# Use a *restricted* key with read-only access to Customers, Subscriptions, Invoices, and
# PaymentMethods if you can — this Worker never writes to Stripe.
STRIPE_SECRET_KEY=
```

- [ ] **Step 7: Update `AGENTS.md`'s deploy sequence**

In `AGENTS.md`, replace step 4 (currently only about `ADMIN_API_TOKEN`):

```markdown
4. Get a value for `ADMIN_API_TOKEN` from the human (or generate one and get their sign-off), then set it in both places it's needed — they are independent and `wrangler` does not sync them:

   ```bash
   cp .dev.vars.example .dev.vars
   # write ADMIN_API_TOKEN=<value> into .dev.vars

   npx wrangler secret put ADMIN_API_TOKEN
   # paste the same value when prompted — this uploads it to the deployed Worker
   ```
```

with:

```markdown
4. Get a value for `ADMIN_API_TOKEN`, and a Stripe secret key for `STRIPE_SECRET_KEY` (ask the human for one — a restricted, read-only test-mode key is enough to verify the deploy works), then set both in the two places they're each needed — local `.dev.vars` and the deployed Worker's secrets are independent and `wrangler` does not sync them:

   ```bash
   cp .dev.vars.example .dev.vars
   # write ADMIN_API_TOKEN=<value> and STRIPE_SECRET_KEY=<value> into .dev.vars

   npx wrangler secret put ADMIN_API_TOKEN
   # paste the ADMIN_API_TOKEN value when prompted — uploads it to the deployed Worker
   npx wrangler secret put STRIPE_SECRET_KEY
   # paste the STRIPE_SECRET_KEY value when prompted
   ```
```

- [ ] **Step 8: Update `README.md`**

In the Quick start section, replace step 4 (same text block as the `AGENTS.md` edit above, adapted to the README's existing step-4 wording) so it covers both secrets the same way Step 7 does for `AGENTS.md`.

In the API reference table, add a row:

```markdown
| `GET` | `/api/stripe/lookup?q=<email\|cus_...\|sub_...>` | Live customer + subscriptions + payment method + recent invoices from Stripe |
```

In the "Security notes" section, add a bullet:

```markdown
- `STRIPE_SECRET_KEY` follows the same handling as `ADMIN_API_TOKEN` — set via `wrangler secret put` for the deployed Worker and `.dev.vars` for local dev, never committed. Use a restricted, read-only key if your Stripe account supports it; this Worker never writes to Stripe.
```

- [ ] **Step 9: Commit**

```bash
git add src/worker.js test/worker.test.js .dev.vars.example AGENTS.md README.md
git commit -m "Add GET /api/stripe/lookup and wire up STRIPE_SECRET_KEY"
```

---

### Task 3: Redesign the admin page as a search-first CRM view

**Files:**
- Modify: `src/worker.js` (replace `ADMIN_HTML`'s body markup and `<script>`)
- Test: `test/worker.test.js` (add a lightweight structural assertion; see note on scope below)

**Interfaces:**
- Consumes: `GET /api/stripe/lookup` (Task 2), the existing `/api/entries` CRUD (unchanged).
- Produces: nothing consumed by a later task — this is the last code task.

**Note on test scope:** This template has no DOM-testing setup (no jsdom, no browser test runner) — `test/worker.test.js` only ever tests pure functions and the router. Adding one would be new build/test infrastructure, which the spec's non-goals rule out for this feature. So this task's automated test is a structural check (the script's `document.getElementById` calls all have a matching `id` in the markup), not a behavioral one — behavior is checked manually in Step 5.

- [ ] **Step 1: Write the failing structural test**

Change the import line in `test/worker.test.js` from:

```js
import worker, { normalizeEntryPayload, validateEntryPayload } from '../src/worker.js';
```

to:

```js
import worker, { normalizeEntryPayload, validateEntryPayload, ADMIN_HTML } from '../src/worker.js';
```

Then append:

```js
test('ADMIN_HTML includes every element id the script depends on', () => {
  for (const id of [
    'token',
    'search-input',
    'search',
    'status',
    'error',
    'result',
    'customer-summary',
    'subscriptions',
    'invoices',
    'entry-form',
    'entry-subscription',
    'entry-key',
    'entry-value',
    'entries',
  ]) {
    assert.match(ADMIN_HTML, new RegExp('id="' + id + '"'), `missing id="${id}"`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/worker.test.js`
Expected: FAIL — the current `ADMIN_HTML` has `customer-id`, `subscription-id`, `filter-subscription`, `load` instead of the new ids; several assertions fail.

- [ ] **Step 3: Replace `ADMIN_HTML`'s body and script**

In `src/worker.js`, replace everything between `<body>` and `</body>` (i.e. from `<h1>Radiatus: Stripe Subscription Admin Entries</h1>` through the closing `</script>`, just before `</body>\n  </html>\`;`) with:

```html
    <h1>Radiatus: Stripe Subscription CRM</h1>
    <p class="muted">Search a customer by email, or a Stripe customer/subscription ID, to see their live status and attach notes.</p>

    <label>Admin API Token</label>
    <input id="token" type="password" placeholder="Paste ADMIN_API_TOKEN" />

    <div class="row">
      <div>
        <label>Search</label>
        <input id="search-input" placeholder="email, cus_..., or sub_..." />
      </div>
      <div>
        <label>&nbsp;</label>
        <button id="search" type="button">Search</button>
      </div>
    </div>

    <p id="status" class="muted"></p>
    <p id="error" class="error"></p>

    <div id="result" hidden>
      <h2>Customer</h2>
      <p id="customer-summary"></p>

      <h2>Subscriptions</h2>
      <table>
        <thead>
          <tr><th>ID</th><th>Status</th><th>Current period</th></tr>
        </thead>
        <tbody id="subscriptions"></tbody>
      </table>

      <h2>Recent invoices</h2>
      <table>
        <thead>
          <tr><th>ID</th><th>Status</th><th>Amount due</th><th>Amount paid</th><th>Date</th></tr>
        </thead>
        <tbody id="invoices"></tbody>
      </table>

      <h2>Notes</h2>
      <form id="entry-form">
        <label>Subscription</label>
        <select id="entry-subscription" required></select>
        <label>Entry Key</label>
        <input id="entry-key" required placeholder="feature_flag" />
        <label>Entry Value (text or JSON)</label>
        <textarea id="entry-value" rows="4" placeholder='{"enabled":true}'></textarea>
        <button type="submit">Add note</button>
      </form>

      <table>
        <thead>
          <tr><th>ID</th><th>Key</th><th>Value</th><th>Actions</th></tr>
        </thead>
        <tbody id="entries"></tbody>
      </table>
    </div>

    <script>
      const tokenNode = document.getElementById('token');
      const searchInput = document.getElementById('search-input');
      const searchButton = document.getElementById('search');
      const statusNode = document.getElementById('status');
      const errorNode = document.getElementById('error');
      const resultNode = document.getElementById('result');
      const customerSummary = document.getElementById('customer-summary');
      const subscriptionsBody = document.getElementById('subscriptions');
      const invoicesBody = document.getElementById('invoices');
      const entriesBody = document.getElementById('entries');
      const entryForm = document.getElementById('entry-form');
      const entrySubscriptionSelect = document.getElementById('entry-subscription');

      let currentCustomerId = null;

      const authHeaders = () => ({
        'Content-Type': 'application/json',
        'Authorization': 'Token ' + tokenNode.value.trim(),
      });

      function setStatus(message) {
        statusNode.textContent = message;
        errorNode.textContent = '';
      }

      function setError(message) {
        errorNode.textContent = message;
      }

      function formatMoney(amount, currency) {
        return (amount / 100).toFixed(2) + ' ' + currency.toUpperCase();
      }

      function formatDate(unixSeconds) {
        return new Date(unixSeconds * 1000).toLocaleDateString();
      }

      function renderSubscriptions(subscriptions) {
        subscriptionsBody.innerHTML = '';
        entrySubscriptionSelect.innerHTML = '';
        for (const subscription of subscriptions) {
          const tr = document.createElement('tr');
          const idCell = document.createElement('td');
          idCell.textContent = subscription.id;
          const statusCell = document.createElement('td');
          statusCell.textContent = subscription.status;
          const periodCell = document.createElement('td');
          periodCell.textContent = formatDate(subscription.currentPeriodStart) + ' - ' + formatDate(subscription.currentPeriodEnd);
          tr.appendChild(idCell);
          tr.appendChild(statusCell);
          tr.appendChild(periodCell);
          subscriptionsBody.appendChild(tr);

          const option = document.createElement('option');
          option.value = subscription.id;
          option.textContent = subscription.id + ' (' + subscription.status + ')';
          entrySubscriptionSelect.appendChild(option);
        }
      }

      function renderInvoices(invoices) {
        invoicesBody.innerHTML = '';
        for (const invoice of invoices) {
          const tr = document.createElement('tr');
          const idCell = document.createElement('td');
          idCell.textContent = invoice.id;
          const statusCell = document.createElement('td');
          statusCell.textContent = invoice.status;
          const dueCell = document.createElement('td');
          dueCell.textContent = formatMoney(invoice.amountDue, invoice.currency);
          const paidCell = document.createElement('td');
          paidCell.textContent = formatMoney(invoice.amountPaid, invoice.currency);
          const dateCell = document.createElement('td');
          dateCell.textContent = formatDate(invoice.created);
          tr.appendChild(idCell);
          tr.appendChild(statusCell);
          tr.appendChild(dueCell);
          tr.appendChild(paidCell);
          tr.appendChild(dateCell);
          invoicesBody.appendChild(tr);
        }
      }

      function renderEntryRow(entry) {
        const tr = document.createElement('tr');

        const idCell = document.createElement('td');
        idCell.textContent = String(entry.id);

        const keyCell = document.createElement('td');
        const keyInput = document.createElement('input');
        keyInput.value = entry.entry_key;
        keyCell.appendChild(keyInput);

        const valueCell = document.createElement('td');
        const valueArea = document.createElement('textarea');
        valueArea.value = entry.entry_value;
        valueCell.appendChild(valueArea);

        const actionsCell = document.createElement('td');
        const saveButton = document.createElement('button');
        saveButton.type = 'button';
        saveButton.textContent = 'Save';
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.textContent = 'Delete';

        saveButton.onclick = async () => {
          try {
            const updateResponse = await fetch('/api/entries/' + entry.id, {
              method: 'PUT',
              headers: authHeaders(),
              body: JSON.stringify({ entryKey: keyInput.value, entryValue: valueArea.value }),
            });
            const updateData = await updateResponse.json();
            if (!updateResponse.ok) {
              throw new Error(updateData.error || 'Failed to update entry');
            }
            setStatus('Updated note ' + entry.id);
          } catch (error) {
            setError(error.message);
          }
        };

        deleteButton.onclick = async () => {
          try {
            const deleteResponse = await fetch('/api/entries/' + entry.id, {
              method: 'DELETE',
              headers: authHeaders(),
            });
            const deleteData = await deleteResponse.json();
            if (!deleteResponse.ok) {
              throw new Error(deleteData.error || 'Failed to delete entry');
            }
            tr.remove();
            setStatus('Deleted note ' + entry.id);
          } catch (error) {
            setError(error.message);
          }
        };

        actionsCell.appendChild(saveButton);
        actionsCell.appendChild(deleteButton);

        tr.appendChild(idCell);
        tr.appendChild(keyCell);
        tr.appendChild(valueCell);
        tr.appendChild(actionsCell);

        return tr;
      }

      async function loadEntries(subscriptionId) {
        const response = await fetch('/api/entries?subscriptionId=' + encodeURIComponent(subscriptionId), {
          headers: authHeaders(),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Failed to load notes');
        }
        entriesBody.innerHTML = '';
        for (const entry of data.entries) {
          entriesBody.appendChild(renderEntryRow(entry));
        }
      }

      async function runSearch() {
        try {
          setStatus('Searching...');
          resultNode.hidden = true;
          const q = searchInput.value.trim();
          const response = await fetch('/api/stripe/lookup?q=' + encodeURIComponent(q), {
            headers: authHeaders(),
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || 'Search failed');
          }

          currentCustomerId = data.customer.id;
          customerSummary.textContent =
            (data.customer.name || '(no name)') + ' — ' + data.customer.email + ' — ' + data.customer.id +
            (data.paymentMethod ? ' — ' + data.paymentMethod.brand + ' •••• ' + data.paymentMethod.last4 : '');

          renderSubscriptions(data.subscriptions);
          renderInvoices(data.invoices);
          resultNode.hidden = false;

          if (data.subscriptions.length > 0) {
            await loadEntries(entrySubscriptionSelect.value);
          } else {
            entriesBody.innerHTML = '';
          }

          setStatus('Found ' + data.customer.email);
        } catch (error) {
          setError(error.message);
        }
      }

      searchButton.addEventListener('click', runSearch);
      searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          runSearch();
        }
      });

      entrySubscriptionSelect.addEventListener('change', async () => {
        try {
          await loadEntries(entrySubscriptionSelect.value);
        } catch (error) {
          setError(error.message);
        }
      });

      entryForm.addEventListener('submit', async (event) => {
        try {
          event.preventDefault();
          const subscriptionId = entrySubscriptionSelect.value;
          if (!subscriptionId) {
            throw new Error('No subscription selected');
          }
          const payload = {
            stripeCustomerId: currentCustomerId,
            stripeSubscriptionId: subscriptionId,
            entryKey: document.getElementById('entry-key').value,
            entryValue: document.getElementById('entry-value').value,
          };
          const response = await fetch('/api/entries', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify(payload),
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || 'Failed to create note');
          }
          setStatus('Added note ' + data.entry.id);
          entryForm.reset();
          await loadEntries(subscriptionId);
        } catch (error) {
          setError(error.message);
        }
      });
    </script>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/worker.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Manual verification**

This exercises the actual browser behavior the structural test can't (no DOM test infra — see the note above). Needs a Stripe test-mode secret key and at least one test customer/subscription in that Stripe account.

1. `cp .dev.vars.example .dev.vars`, fill in `ADMIN_API_TOKEN` and a Stripe **test-mode** `STRIPE_SECRET_KEY`.
2. `npm run dev`, open `http://127.0.0.1:8787/admin`, paste the admin token.
3. Search by the test customer's email. Confirm: subscriptions and invoices render, the subscription dropdown in the Notes form is populated.
4. Add a note; confirm it appears in the notes table scoped to the selected subscription.
5. Re-search by the subscription's `sub_...` ID directly; confirm it resolves to the same customer.
6. Search a nonexistent email; confirm a clear "Not found" message, not a crash or blank screen.

- [ ] **Step 6: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/worker.js test/worker.test.js
git commit -m "Redesign the admin page as a search-first Stripe/D1 CRM view"
```

---

### Task 4: Rebrand copy

**Files:**
- Modify: `package.json:4` (`description`)
- Modify: `README.md` (H1 subtitle, "Key features" section)

**Interfaces:** None — copy-only, no code.

- [ ] **Step 1: Update `package.json`**

Change:

```json
  "description": "An open-source dashboard for managing Stripe subscriptions with Cloudflare",
```

to:

```json
  "description": "An open-source CRM connecting Stripe and Cloudflare.",
```

- [ ] **Step 2: Update the README subtitle**

Change:

```markdown
<p align="center">
  <em>An open-source starter for building an admin surface over Stripe subscriptions, running entirely on Cloudflare.</em>
</p>
```

to:

```markdown
<p align="center">
  <em>An open-source CRM connecting Stripe and Cloudflare &mdash; search a customer, see their subscription status, and leave notes for your team.</em>
</p>
```

- [ ] **Step 3: Update the "Key features" section**

Change the bullet list:

```markdown
- **Zero servers**: runs entirely on Cloudflare Workers + D1 — nothing to provision, patch, or scale by hand.
- **Stripe-shaped by default**: every record is keyed to a `stripe_customer_id` and `stripe_subscription_id` out of the box.
- **Admin UI included**: a built-in `/admin` page for create/list/update/delete — no separate frontend to build.
- **Token-gated API**: every `/api/*` route requires an `Authorization: Token <token>` secret; nothing is open by default.
- **One-command deploy**: `wrangler deploy` ships the Worker, `wrangler d1 migrations apply` runs migrations.
```

to:

```markdown
- **Search-first troubleshooting**: look up a customer by email, or a Stripe customer/subscription ID, and see their live status, billing period, payment method, and recent invoices — not just what's stored locally.
- **Notes on top of live data**: attach internal notes/flags to a customer or subscription, layered on top of the real Stripe record instead of replacing it.
- **Zero servers**: runs entirely on Cloudflare Workers + D1 — nothing to provision, patch, or scale by hand.
- **Token-gated API**: every `/api/*` route (including the Stripe lookup) requires an `Authorization: Token <token>` secret; nothing is open by default.
- **One-command deploy**: `wrangler deploy` ships the Worker, `wrangler d1 migrations apply` runs migrations.
```

- [ ] **Step 4: Read through the full README once**

Confirm nothing else still describes the page as a plain "admin surface" or "list of entries" — the Quick start, API reference, and Project structure sections from earlier tasks already reflect the CRM behavior; this step is just a final consistency pass over prose, not a checklist of specific edits.

- [ ] **Step 5: Commit**

```bash
git add package.json README.md
git commit -m "Rebrand copy: an open-source CRM connecting Stripe and Cloudflare"
```
