import test from 'node:test';
import assert from 'node:assert/strict';

import worker, { normalizeEntryPayload, validateEntryPayload, ADMIN_HTML } from '../src/worker.js';
import { resetTokenCache } from '../src/graph.js';

const GRAPH_CLIENT_SECRET = 'graph-client-SECRETVALUE';
const GRAPH_ENV = {
  ADMIN_API_TOKEN: 'secret',
  GRAPH_TENANT_ID: 'tenant-abc',
  GRAPH_CLIENT_ID: 'client-abc',
  GRAPH_CLIENT_SECRET,
  GRAPH_MAILBOX: 'support@example.com',
};

function graphJson(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Routes by hostname so assertions do not depend on whether a token was cached. */
function stubGraphFetch(onGraph) {
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'login.microsoftonline.com') {
      return graphJson({ access_token: 'graph-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (url.hostname === 'graph.microsoft.com') {
      return onGraph(url);
    }
    throw new Error('Unexpected fetch to ' + url.href);
  };
}

function mailRequest(query = 'person@example.com') {
  const suffix = query === null ? '' : '?q=' + encodeURIComponent(query);
  return new Request('https://worker.example/api/mail/lookup' + suffix, {
    headers: { Authorization: 'Token secret' },
  });
}

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

test('/api/mail/lookup rejects an unauthorized request', async () => {
  const request = new Request('https://worker.example/api/mail/lookup?q=person@example.com');
  const response = await worker.fetch(request, GRAPH_ENV);
  assert.equal(response.status, 401);
});

test('/api/mail/lookup requires q', async () => {
  assert.equal((await worker.fetch(mailRequest(null), GRAPH_ENV)).status, 400);
  assert.equal((await worker.fetch(mailRequest('   '), GRAPH_ENV)).status, 400);
});

test('/api/mail/lookup rejects an oversized q before it reaches Graph', async () => {
  let graphCalls = 0;
  const originalFetch = globalThis.fetch;
  stubGraphFetch(() => {
    graphCalls += 1;
    return graphJson({ value: [] });
  });
  try {
    const response = await worker.fetch(mailRequest('a'.repeat(400) + '@example.com'), GRAPH_ENV);
    assert.equal(response.status, 400);
    assert.equal(graphCalls, 0, 'an oversized q must not reach Graph, where it returns a 400 that reads as a mailbox capability finding');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('/api/mail/lookup returns 501 when GRAPH_MAILBOX is unset', async () => {
  const response = await worker.fetch(mailRequest(), { ...GRAPH_ENV, GRAPH_MAILBOX: undefined });
  assert.equal(response.status, 501);
  assert.deepEqual(await response.json(), { error: 'Office 365 mail lookup is not configured' });
});

test('/api/mail/lookup returns 501 when the Graph app credentials are unset', async () => {
  for (const key of ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET']) {
    const response = await worker.fetch(mailRequest(), { ...GRAPH_ENV, [key]: undefined });
    assert.equal(response.status, 501, key + ' unset should yield 501');
  }
  const bare = await worker.fetch(mailRequest(), { ADMIN_API_TOKEN: 'secret' });
  assert.equal(bare.status, 501);
});

test('/api/mail/lookup returns 502 on a Graph failure without leaking the client secret', async () => {
  const originalFetch = globalThis.fetch;
  resetTokenCache();
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'login.microsoftonline.com') {
      return graphJson(
        {
          error: 'invalid_client',
          error_description: 'AADSTS7000215: Invalid client secret provided: ' + GRAPH_CLIENT_SECRET,
        },
        401
      );
    }
    throw new Error('Graph must not be called without a token');
  };
  try {
    const response = await worker.fetch(mailRequest(), GRAPH_ENV);
    assert.equal(response.status, 502);
    const bodyText = await response.text();
    assert.ok(!bodyText.includes('SECRETVALUE'), 'response body must not contain the Graph client secret');
    assert.ok(!bodyText.includes('AADSTS'), 'response body must not forward the raw Graph message');
    assert.deepEqual(JSON.parse(bodyText), { error: 'Microsoft Graph error', graphStatus: 401 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('/api/mail/lookup returns message metadata and no-store on success', async () => {
  const originalFetch = globalThis.fetch;
  resetTokenCache();
  stubGraphFetch((url) => {
    assert.equal(url.pathname, '/v1.0/users/support%40example.com/messages');
    return graphJson({
      value: [
        {
          id: 'AAMkAD_1',
          subject: 'Refund request',
          from: { emailAddress: { name: 'Person', address: 'person@example.com' } },
          toRecipients: [{ emailAddress: { name: 'Support', address: 'support@example.com' } }],
          receivedDateTime: '2026-08-30T10:15:00Z',
          webLink: 'https://outlook.office365.com/owa/?ItemID=AAMkAD_1',
          conversationId: 'conv_1',
          hasAttachments: false,
          bodyPreview: 'PRIVATE BODY TEXT',
        },
      ],
    });
  });
  try {
    const response = await worker.fetch(mailRequest(), GRAPH_ENV);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const bodyText = await response.text();
    assert.ok(!bodyText.includes('PRIVATE BODY TEXT'), 'message bodies must never reach the client');
    const body = JSON.parse(bodyText);
    assert.equal(body.mode, 'search');
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].subject, 'Refund request');
    assert.equal(body.messages[0].webLink, 'https://outlook.office365.com/owa/?ItemID=AAMkAD_1');
    assert.deepEqual(body.messages[0].from, { name: 'Person', address: 'person@example.com' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('/api/mail/lookup reports sender-only mode when Graph refuses $search', async () => {
  const originalFetch = globalThis.fetch;
  resetTokenCache();
  stubGraphFetch((url) => {
    if (url.searchParams.has('$search')) {
      return graphJson({ error: { code: 'BadRequest', message: 'Search is not supported' } }, 400);
    }
    return graphJson({ value: [] });
  });
  try {
    const response = await worker.fetch(mailRequest(), GRAPH_ENV);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.mode, 'sender-only');
    assert.deepEqual(body.messages, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('/api/mail/lookup reads the mailbox from env, never from the query string', async () => {
  const originalFetch = globalThis.fetch;
  resetTokenCache();
  const requestedPaths = [];
  stubGraphFetch((url) => {
    requestedPaths.push(url.pathname);
    return graphJson({ value: [] });
  });
  try {
    // Every parameter an attacker might hope names a mailbox.
    const request = new Request(
      'https://worker.example/api/mail/lookup?q=victim%40example.com&mailbox=ceo%40example.com' +
        '&GRAPH_MAILBOX=ceo%40example.com&user=ceo%40example.com',
      { headers: { Authorization: 'Token secret' } }
    );
    const response = await worker.fetch(request, GRAPH_ENV);
    assert.equal(response.status, 200);
    assert.deepEqual(requestedPaths, ['/v1.0/users/support%40example.com/messages']);
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
    'load-mail',
    'mail-status',
    'messages',
    'entry-form',
    'entry-subscription',
    'entry-key',
    'entry-value',
    'entries',
  ]) {
    assert.match(ADMIN_HTML, new RegExp('id="' + id + '"'), `missing id="${id}"`);
  }
});
