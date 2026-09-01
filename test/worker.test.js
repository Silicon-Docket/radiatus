import test from 'node:test';
import assert from 'node:assert/strict';

import worker, { normalizeEntryPayload, validateEntryPayload } from '../src/worker.js';

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
