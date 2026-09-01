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
