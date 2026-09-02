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
  listSubscriptionsForCustomer,
  listInvoicesForCustomer,
} from '../src/stripe';

const ENV = { STRIPE_SECRET_KEY: 'sk_test_123' };
const originalFetch = globalThis.fetch;

/** `fetch` may be handed a string, a Request, or a URL; all three reach these stubs. */
function toUrl(input: RequestInfo | URL): URL {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

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
  globalThis.fetch = async (url: RequestInfo | URL) => {
    const parsed = toUrl(url);
    assert.equal(parsed.pathname, '/v1/customers');
    assert.equal(parsed.searchParams.get('email'), 'person@example.com');
    return new Response(JSON.stringify({ data: [{ id: 'cus_1', email: 'person@example.com' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const customer = await findCustomerByEmail(ENV, 'person@example.com');
    assert.ok(customer); // narrows StripeCustomer | null for the access below
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

test('findCustomerByEmail retries lowercased when the typed casing finds nothing', async () => {
  const searched: (string | null)[] = [];
  globalThis.fetch = async (url: RequestInfo | URL) => {
    const email = toUrl(url).searchParams.get('email');
    searched.push(email);
    const data = email === 'person@example.com' ? [{ id: 'cus_1', email: 'person@example.com' }] : [];
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const customer = await findCustomerByEmail(ENV, 'Person@Example.com');
    assert.ok(customer); // narrows StripeCustomer | null for the access below
    assert.equal(customer.id, 'cus_1');
    assert.deepEqual(searched, ['Person@Example.com', 'person@example.com']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('findCustomerByEmail does not make a second request when the typed casing matches', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ data: [{ id: 'cus_1', email: 'person@example.com' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await findCustomerByEmail(ENV, 'person@example.com');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('findCustomerByEmail returns null without calling Stripe for a blank email', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    assert.equal(await findCustomerByEmail(ENV, '   '), null);
    assert.equal(await findCustomerByEmail(ENV, ''), null);
    assert.equal(calls, 0);
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
  globalThis.fetch = async (url: RequestInfo | URL) => {
    const { pathname } = toUrl(url);
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
    assert.ok(result.found); // narrows the found:true branch for the accesses below
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

test('path traversal attempts are encoded and cannot escape to other endpoints', async () => {
  globalThis.fetch = async (url: RequestInfo | URL) => {
    const parsed = toUrl(url);
    // Verify the path stays within /v1/customers even with traversal attempt
    assert.equal(parsed.pathname, '/v1/customers/cus_a%2F..%2F..%2Fbalance');
    return new Response(JSON.stringify({ error: { message: 'No such customer' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    // Attempt to traverse to /v1/balance endpoint
    await getCustomer(ENV, 'cus_a/../../balance');
    // Should get 404 but path should be encoded
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('classifyQuery rejects malicious IDs with special characters and treats them as email', () => {
  // Path traversal attempt should not be classified as customer
  assert.deepEqual(classifyQuery('cus_a/../../balance'), { type: 'email', value: 'cus_a/../../balance' });
  // Query string injection attempt should not be classified as subscription
  assert.deepEqual(classifyQuery('sub_x?limit=999'), { type: 'email', value: 'sub_x?limit=999' });
});

test('listSubscriptionsForCustomer throws if customerId is falsy', async () => {
  await assert.rejects(
    () => listSubscriptionsForCustomer(ENV, null),
    /customerId is required/
  );
  await assert.rejects(
    () => listSubscriptionsForCustomer(ENV, ''),
    /customerId is required/
  );
});

test('listInvoicesForCustomer throws if customerId is falsy', async () => {
  await assert.rejects(
    () => listInvoicesForCustomer(ENV, null),
    /customerId is required/
  );
  await assert.rejects(
    () => listInvoicesForCustomer(ENV, ''),
    /customerId is required/
  );
});

test('lookupStripeRecord handles subscription-ID lookup by fetching subscription then customer', async () => {
  globalThis.fetch = async (url: RequestInfo | URL) => {
    const { pathname } = toUrl(url);
    if (pathname === '/v1/subscriptions/sub_1') {
      return new Response(
        JSON.stringify({
          id: 'sub_1',
          status: 'active',
          customer: 'cus_2',
          current_period_start: 100,
          current_period_end: 200,
          cancel_at_period_end: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (pathname === '/v1/customers/cus_2') {
      return new Response(
        JSON.stringify({
          id: 'cus_2',
          email: 'sub_owner@example.com',
          name: 'Subscription Owner',
          invoice_settings: { default_payment_method: 'pm_1' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (pathname === '/v1/subscriptions') {
      return new Response(
        JSON.stringify({ data: [{ id: 'sub_1', status: 'active', current_period_start: 100, current_period_end: 200, cancel_at_period_end: false }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (pathname === '/v1/invoices') {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
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
    const result = await lookupStripeRecord(ENV, 'sub_1');
    assert.equal(result.found, true);
    assert.ok(result.found); // narrows the found:true branch for the accesses below
    assert.equal(result.customer.id, 'cus_2');
    assert.equal(result.customer.email, 'sub_owner@example.com');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('shapeSubscription handles Basil API version with period fields in items[0]', () => {
  const basilShaped = shapeSubscription({
    id: 'sub_1',
    status: 'active',
    cancel_at_period_end: false,
    items: {
      data: [
        {
          current_period_start: 3000,
          current_period_end: 4000,
        },
      ],
    },
  });
  assert.deepEqual(basilShaped, {
    id: 'sub_1',
    status: 'active',
    currentPeriodStart: 3000,
    currentPeriodEnd: 4000,
    cancelAtPeriodEnd: false,
  });
});

test('getCustomer returns null for deleted customers', async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ id: 'cus_deleted', email: 'old@example.com', deleted: true }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  try {
    const customer = await getCustomer(ENV, 'cus_deleted');
    assert.equal(customer, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('lookupStripeRecord returns partial result if payment method fetch fails', async () => {
  globalThis.fetch = async (url: RequestInfo | URL) => {
    const { pathname } = toUrl(url);
    if (pathname === '/v1/customers/cus_1') {
      return new Response(
        JSON.stringify({
          id: 'cus_1',
          email: 'person@example.com',
          name: 'Person Example',
          invoice_settings: { default_payment_method: 'pm_broken' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (pathname === '/v1/subscriptions') {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (pathname === '/v1/invoices') {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (pathname === '/v1/payment_methods/pm_broken') {
      // Return a rate limit error on payment method fetch
      return new Response(JSON.stringify({ error: { message: 'Rate limited' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('Unexpected fetch to ' + pathname);
  };
  try {
    const result = await lookupStripeRecord(ENV, 'cus_1');
    assert.equal(result.found, true);
    assert.ok(result.found); // narrows the found:true branch for the accesses below
    assert.equal(result.customer.email, 'person@example.com');
    assert.equal(result.subscriptions.length, 0);
    assert.equal(result.invoices.length, 0);
    assert.equal(result.paymentMethod, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('stripeRequest throws StripeApiError on invalid JSON response', async () => {
  globalThis.fetch = async () =>
    new Response('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    });
  try {
    await assert.rejects(() => getCustomer(ENV, 'cus_1'), (err) => {
      return err instanceof StripeApiError && err.status === 502 && err.message === 'Invalid response from Stripe';
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
