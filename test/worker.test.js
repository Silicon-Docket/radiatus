import test from 'node:test';
import assert from 'node:assert/strict';

import worker, { normalizeEntryPayload, validateEntryPayload, ADMIN_HTML } from '../src/worker.js';

test('normalizeEntryPayload trims and stringifies input', () => {
  const payload = normalizeEntryPayload({
    stripeCustomerId: '  cus_123  ',
    stripeSubscriptionId: ' sub_123 ',
    entryKey: ' plan ',
    entryValue: 42,
  });

  assert.deepEqual(payload, {
    stripeCustomerId: 'cus_123',
    stripeSubscriptionId: 'sub_123',
    entryKey: 'plan',
    entryValue: '42',
  });
});

test('validateEntryPayload requires subscription-linked fields', () => {
  const validation = validateEntryPayload({ entryKey: 'x' });
  assert.equal(validation.ok, false);
  assert.match(validation.error, /required/);
});

test('validateEntryPayload accepts expected payload', () => {
  const validation = validateEntryPayload({
    stripeCustomerId: 'cus_abc',
    stripeSubscriptionId: 'sub_abc',
    entryKey: 'feature',
    entryValue: '{"enabled":true}',
  });

  assert.equal(validation.ok, true);
  assert.equal(validation.value.stripeCustomerId, 'cus_abc');
  assert.equal(validation.value.stripeSubscriptionId, 'sub_abc');
});

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

test('/api/stripe/lookup never leaks STRIPE_SECRET_KEY into a 502 body', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ error: { message: 'Invalid API Key provided: sk_test_SECRETVALUE' } }),
      { status: 401, headers: { 'content-type': 'application/json' } }
    );
  try {
    const request = new Request('https://worker.example/api/stripe/lookup?q=cus_1', {
      headers: { Authorization: 'Token secret' },
    });
    const response = await worker.fetch(request, { ADMIN_API_TOKEN: 'secret', STRIPE_SECRET_KEY: 'sk_test_SECRETVALUE' });
    assert.equal(response.status, 502);
    const bodyText = await response.text();
    assert.ok(!bodyText.includes('SECRETVALUE'), 'response body must not contain the Stripe secret key');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('/api/stripe/lookup returns 500 when STRIPE_SECRET_KEY is not configured', async () => {
  const request = new Request('https://worker.example/api/stripe/lookup?q=cus_1', {
    headers: { Authorization: 'Token secret' },
  });
  const response = await worker.fetch(request, { ADMIN_API_TOKEN: 'secret' });
  assert.equal(response.status, 500);
});

test('/api/stripe/lookup returns the full lookup shape on success', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname === '/v1/customers') {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'cus_1',
              email: 'someone@example.com',
              name: 'Someone',
              invoice_settings: { default_payment_method: 'pm_1' },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.pathname === '/v1/subscriptions') {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'sub_1',
              status: 'active',
              current_period_start: 1700000000,
              current_period_end: 1702592000,
              cancel_at_period_end: false,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.pathname === '/v1/invoices') {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'in_1',
              status: 'paid',
              amount_due: 1000,
              amount_paid: 1000,
              currency: 'usd',
              created: 1700000000,
              hosted_invoice_url: 'https://invoice.example/in_1',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.pathname === '/v1/payment_methods/pm_1') {
      return new Response(
        JSON.stringify({ id: 'pm_1', card: { brand: 'visa', last4: '4242' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    throw new Error('Unexpected fetch to ' + url.pathname);
  };
  try {
    const request = new Request('https://worker.example/api/stripe/lookup?q=someone@example.com', {
      headers: { Authorization: 'Token secret' },
    });
    const response = await worker.fetch(request, { ADMIN_API_TOKEN: 'secret', STRIPE_SECRET_KEY: 'sk_test' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.customer.id, 'cus_1');
    assert.equal(body.customer.email, 'someone@example.com');
    assert.equal(body.subscriptions[0].id, 'sub_1');
    assert.equal(body.subscriptions[0].status, 'active');
    assert.equal(body.invoices[0].id, 'in_1');
    assert.equal(body.invoices[0].amountDue, 1000);
    assert.deepEqual(body.paymentMethod, { brand: 'visa', last4: '4242' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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
