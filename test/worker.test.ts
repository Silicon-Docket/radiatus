import test from 'node:test';
import assert from 'node:assert/strict';

import worker, {
  normalizeEntryPayload,
  validateEntryPayload,
  parseFlaggedOnly,
  ADMIN_HTML,
  type AccountRow,
} from '../src/worker';
import { resetTokenCache } from '../src/graph';
import type { CorrespondenceResult } from '../src/graph';
import type { ShapedCustomer, ShapedInvoice, ShapedPaymentMethod, ShapedSubscription } from '../src/stripe';
import { createFakeD1, type AccountSeed } from './fake-d1';

/**
 * `Env.DB` is a required binding, but none of the routes exercised here reaches
 * D1. Every method throws, so a test that starts touching the database fails
 * loudly instead of passing against a silent no-op.
 */
function unusedDb(): D1Database {
  const unreachable = (): never => {
    throw new Error('these tests must not touch env.DB');
  };
  return {
    prepare: unreachable,
    batch: unreachable,
    exec: unreachable,
    withSession: unreachable,
    dump: unreachable,
  };
}

const DB = unusedDb();

/** The body /api/stripe/lookup returns, in terms of the module's own shaped types. */
interface LookupResponseBody {
  customer: ShapedCustomer;
  paymentMethod: ShapedPaymentMethod | null;
  subscriptions: ShapedSubscription[];
  invoices: ShapedInvoice[];
}

const GRAPH_CLIENT_SECRET = 'graph-client-SECRETVALUE';
const GRAPH_ENV = {
  DB,
  ADMIN_API_TOKEN: 'secret',
  GRAPH_TENANT_ID: 'tenant-abc',
  GRAPH_CLIENT_ID: 'client-abc',
  GRAPH_CLIENT_SECRET,
  GRAPH_MAILBOX: 'support@example.com',
};

/** `fetch` may be handed a string, a Request, or a URL; all three reach these stubs. */
function toUrl(input: RequestInfo | URL): URL {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

function graphJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Routes by hostname so assertions do not depend on whether a token was cached. */
function stubGraphFetch(onGraph: (url: URL) => Response): void {
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = toUrl(input);
    if (url.hostname === 'login.microsoftonline.com') {
      return graphJson({ access_token: 'graph-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (url.hostname === 'graph.microsoft.com') {
      return onGraph(url);
    }
    throw new Error('Unexpected fetch to ' + url.href);
  };
}

function mailRequest(query: string | null = 'person@example.com'): Request {
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
  assert.ok(!validation.ok); // narrows the failure branch for the access below
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
  assert.ok(validation.ok); // narrows the success branch for the accesses below
  assert.equal(validation.value.stripeCustomerId, 'cus_abc');
  assert.equal(validation.value.stripeSubscriptionId, 'sub_abc');
});

test('/api/stripe/lookup requires q', async () => {
  const request = new Request('https://worker.example/api/stripe/lookup', {
    headers: { Authorization: 'Token secret' },
  });
  const response = await worker.fetch(request, { DB, ADMIN_API_TOKEN: 'secret', STRIPE_SECRET_KEY: 'sk_test' });
  assert.equal(response.status, 400);
});

test('/api/stripe/lookup rejects an unauthorized request', async () => {
  const request = new Request('https://worker.example/api/stripe/lookup?q=cus_1');
  const response = await worker.fetch(request, { DB, ADMIN_API_TOKEN: 'secret', STRIPE_SECRET_KEY: 'sk_test' });
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
    const response = await worker.fetch(request, { DB, ADMIN_API_TOKEN: 'secret', STRIPE_SECRET_KEY: 'sk_test' });
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
    const response = await worker.fetch(request, { DB, ADMIN_API_TOKEN: 'secret', STRIPE_SECRET_KEY: 'sk_test' });
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
    const response = await worker.fetch(request, { DB, ADMIN_API_TOKEN: 'secret', STRIPE_SECRET_KEY: 'sk_test_SECRETVALUE' });
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
  const response = await worker.fetch(request, { DB, ADMIN_API_TOKEN: 'secret' });
  assert.equal(response.status, 500);
});

test('/api/stripe/lookup returns the full lookup shape on success', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = toUrl(input);
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
    const response = await worker.fetch(request, { DB, ADMIN_API_TOKEN: 'secret', STRIPE_SECRET_KEY: 'sk_test' });
    assert.equal(response.status, 200);
    const body = await response.json<LookupResponseBody>();
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
  for (const key of ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET'] as const) {
    const response = await worker.fetch(mailRequest(), { ...GRAPH_ENV, [key]: undefined });
    assert.equal(response.status, 501, key + ' unset should yield 501');
  }
  const bare = await worker.fetch(mailRequest(), { DB, ADMIN_API_TOKEN: 'secret' });
  assert.equal(bare.status, 501);
});

test('/api/mail/lookup returns 502 on a Graph failure without leaking the client secret', async () => {
  const originalFetch = globalThis.fetch;
  resetTokenCache();
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = toUrl(input);
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
    const body: CorrespondenceResult = JSON.parse(bodyText);
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
    const body = await response.json<CorrespondenceResult>();
    assert.equal(body.mode, 'sender-only');
    assert.deepEqual(body.messages, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('/api/mail/lookup reads the mailbox from env, never from the query string', async () => {
  const originalFetch = globalThis.fetch;
  resetTokenCache();
  const requestedPaths: string[] = [];
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

const SEED_ACCOUNTS: AccountSeed[] = [
  {
    email: 'ada@example.com',
    stripe_customer_id: 'cus_1',
    flagged: 1,
    flag_reason: 'refund-mention',
    flag_subject: 'Refund request',
    last_flagged_at: '2026-08-30T10:15:00Z',
    first_seen_at: '2026-08-01T09:00:00Z',
  },
  {
    email: 'grace@example.com',
    stripe_customer_id: 'cusX1',
    flagged: 0,
    flag_reason: 'refund-mention',
    flag_subject: 'old refund thread',
    last_flagged_at: '2026-08-29T08:00:00Z',
    first_seen_at: '2026-08-02T09:00:00Z',
  },
  {
    email: 'linus@example.com',
    stripe_customer_id: null,
    flagged: 1,
    flag_reason: 'refund-mention',
    flag_subject: 'refund now',
    last_flagged_at: '2026-08-31T11:00:00Z',
    first_seen_at: '2026-08-31T11:00:00Z',
  },
];

/** The two bodies the accounts routes answer with. */
interface AccountsListBody {
  accounts: AccountRow[];
  flaggedOnly: boolean;
}

interface ResolveBody {
  account: AccountRow;
}

function accountsRequest(query = ''): Request {
  return new Request('https://worker.example/api/accounts' + query, {
    headers: { Authorization: 'Token secret' },
  });
}

function resolveRequest(body: unknown): Request {
  return new Request('https://worker.example/api/accounts/resolve', {
    method: 'POST',
    headers: { Authorization: 'Token secret', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function scheduledEvent(): ScheduledController {
  return { scheduledTime: Date.parse('2026-09-01T00:00:00Z'), cron: '*/15 * * * *', noRetry: () => {} };
}

/**
 * Like `unusedDb` above: the members the scheduled handler has no business
 * touching throw rather than being cast away, so a handler that starts using
 * one fails here instead of quietly working against a stub.
 */
function scheduledContext(onWaitUntil: (promise: Promise<unknown>) => void): ExecutionContext {
  const unreachable = (): never => {
    throw new Error('the scheduled handler must not use this');
  };
  return {
    waitUntil: onWaitUntil,
    passThroughOnException: unreachable,
    abort: unreachable,
    get exports(): never {
      return unreachable();
    },
    get props(): never {
      return unreachable();
    },
    get tracing(): never {
      return unreachable();
    },
  };
}

test('parseFlaggedOnly defaults to true and only an explicit false turns it off', () => {
  assert.equal(parseFlaggedOnly(null), true, 'absent must mean flagged-only, matching the UI default');
  assert.equal(parseFlaggedOnly(undefined), true);
  assert.equal(parseFlaggedOnly(''), true);
  assert.equal(parseFlaggedOnly('true'), true);
  assert.equal(parseFlaggedOnly('1'), true);
  assert.equal(parseFlaggedOnly('yes'), true);
  assert.equal(parseFlaggedOnly('false'), false);
  assert.equal(parseFlaggedOnly('FALSE'), false);
  assert.equal(parseFlaggedOnly(' 0 '), false);
  assert.equal(parseFlaggedOnly('no'), false);
});

test('/api/accounts rejects an unauthorized request', async () => {
  const { db } = createFakeD1({ accounts: SEED_ACCOUNTS });
  const request = new Request('https://worker.example/api/accounts');
  const response = await worker.fetch(request, { ADMIN_API_TOKEN: 'secret', DB: db });
  assert.equal(response.status, 401);
});

test('/api/accounts lists flagged accounts only when the parameter is absent', async () => {
  const { db } = createFakeD1({ accounts: SEED_ACCOUNTS });
  const response = await worker.fetch(accountsRequest(), { ADMIN_API_TOKEN: 'secret', DB: db });
  assert.equal(response.status, 200);
  const body = await response.json<AccountsListBody>();

  assert.equal(body.flaggedOnly, true);
  // Newest flag first, and the cleared account is not listed.
  assert.deepEqual(
    body.accounts.map((account) => account.email),
    ['linus@example.com', 'ada@example.com']
  );
  assert.equal(body.accounts[0].flag_reason, 'refund-mention');
  assert.equal(body.accounts[0].flag_subject, 'refund now');
  // flag_subject is a support-mail subject copied verbatim — message content,
  // held to the same rule as /api/mail/lookup rather than left cacheable.
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('/api/accounts?flaggedOnly=false also lists accounts whose flag was cleared', async () => {
  const { db } = createFakeD1({ accounts: SEED_ACCOUNTS });
  const response = await worker.fetch(accountsRequest('?flaggedOnly=false'), {
    ADMIN_API_TOKEN: 'secret',
    DB: db,
  });
  const body = await response.json<AccountsListBody>();

  assert.equal(body.flaggedOnly, false);
  // Still newest-flag-first; the cleared account now appears in its place.
  assert.deepEqual(
    body.accounts.map((account) => account.email),
    ['linus@example.com', 'ada@example.com', 'grace@example.com']
  );
});

test('/api/accounts?q= matches email or Stripe customer id, case-insensitively', async () => {
  const { db } = createFakeD1({ accounts: SEED_ACCOUNTS });
  const env = { ADMIN_API_TOKEN: 'secret', DB: db };

  const byEmail = await (await worker.fetch(accountsRequest('?q=ADA'), env)).json<AccountsListBody>();
  assert.deepEqual(byEmail.accounts.map((a) => a.email), ['ada@example.com']);

  const byCustomer = await (
    await worker.fetch(accountsRequest('?q=cus_1&flaggedOnly=false'), env)
  ).json<AccountsListBody>();
  // cus_1 must not also drag in cusX1: the underscore is a LIKE wildcard and
  // has to be escaped, or every Stripe id search is subtly wrong.
  assert.deepEqual(byCustomer.accounts.map((a) => a.email), ['ada@example.com']);

  const byWildcard = await (
    await worker.fetch(accountsRequest('?q=%25&flaggedOnly=false'), env)
  ).json<AccountsListBody>();
  assert.deepEqual(byWildcard.accounts, [], 'a literal % must not match everything');
});

test('/api/accounts rejects an oversized q', async () => {
  const { db, statements } = createFakeD1({ accounts: SEED_ACCOUNTS });
  const response = await worker.fetch(accountsRequest('?q=' + 'a'.repeat(400)), {
    ADMIN_API_TOKEN: 'secret',
    DB: db,
  });
  assert.equal(response.status, 400);
  assert.equal(statements.length, 0, 'an oversized q must not reach the database');
});

test('/api/accounts cannot be used to inject SQL through q', async () => {
  const { db, statements, accounts } = createFakeD1({ accounts: SEED_ACCOUNTS });
  const injection = "' OR 1=1; DROP TABLE accounts; --";
  const response = await worker.fetch(
    accountsRequest('?q=' + encodeURIComponent(injection) + '&flaggedOnly=false'),
    { ADMIN_API_TOKEN: 'secret', DB: db }
  );

  assert.equal(response.status, 200);
  const body = await response.json<AccountsListBody>();
  assert.deepEqual(body.accounts, [], 'the payload is a search term, not syntax — it matches nothing');
  assert.equal(accounts.size, 3, 'nothing was dropped');
  for (const statement of statements) {
    assert.ok(!statement.sql.includes('DROP TABLE'), 'q must never appear in the SQL text');
    assert.ok(!statement.sql.includes('1=1'));
  }
  assert.ok(statements.some((statement) => statement.bindings.some((value) => String(value).includes(injection))));
});

test('POST /api/accounts/resolve clears the flag but keeps the row and its history', async () => {
  const { db, accounts } = createFakeD1({ accounts: SEED_ACCOUNTS });
  const env = { ADMIN_API_TOKEN: 'secret', DB: db };

  const response = await worker.fetch(resolveRequest({ email: 'ada@example.com' }), env);
  assert.equal(response.status, 200);
  const body = await response.json<ResolveBody>();

  assert.equal(body.account.flagged, 0);
  assert.equal(body.account.flag_reason, 'refund-mention', 'history is kept, not erased');
  assert.equal(body.account.first_seen_at, '2026-08-01T09:00:00Z');
  assert.equal(accounts.size, 3, 'clearing a flag is not a delete');

  const listed = await (await worker.fetch(accountsRequest(), env)).json<AccountsListBody>();
  assert.deepEqual(listed.accounts.map((a) => a.email), ['linus@example.com']);
});

test('POST /api/accounts/resolve lowercases the email before it reaches the database', async () => {
  const { db, statements, accounts } = createFakeD1({ accounts: SEED_ACCOUNTS });
  const response = await worker.fetch(resolveRequest({ email: '  Ada@Example.COM  ' }), {
    ADMIN_API_TOKEN: 'secret',
    DB: db,
  });

  assert.equal(response.status, 200);
  assert.equal(accounts.get('ada@example.com')?.flagged, 0);
  const update = statements.find((statement) => statement.sql.startsWith('UPDATE accounts'));
  assert.deepEqual(update?.bindings, ['ada@example.com']);
});

test('POST /api/accounts/resolve validates the email and 404s on an unknown one', async () => {
  const { db } = createFakeD1({ accounts: SEED_ACCOUNTS });
  const env = { ADMIN_API_TOKEN: 'secret', DB: db };

  assert.equal((await worker.fetch(resolveRequest({}), env)).status, 400);
  assert.equal((await worker.fetch(resolveRequest({ email: '   ' }), env)).status, 400);
  assert.equal((await worker.fetch(resolveRequest({ email: 'a'.repeat(400) }), env)).status, 400);
  assert.equal((await worker.fetch(resolveRequest({ email: 'nobody@example.com' }), env)).status, 404);

  const unauthorized = new Request('https://worker.example/api/accounts/resolve', { method: 'POST' });
  assert.equal((await worker.fetch(unauthorized, env)).status, 401);
});

test('the scheduled handler does nothing at all when Graph is not configured', async () => {
  const originalFetch = globalThis.fetch;
  const { db, statements } = createFakeD1();
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return graphJson({ value: [] });
  };
  try {
    // The common case by far: an adopter who never enabled the mail feature.
    // A cron firing every 15 minutes must not error, and must not touch D1.
    for (const env of [
      { DB: db, ADMIN_API_TOKEN: 'secret' },
      { DB: db, ADMIN_API_TOKEN: 'secret', STRIPE_SECRET_KEY: 'sk_test' },
      { ...GRAPH_ENV, DB: db, GRAPH_MAILBOX: undefined },
      { ...GRAPH_ENV, DB: db, GRAPH_CLIENT_SECRET: undefined },
    ]) {
      await worker.scheduled(scheduledEvent(), env, scheduledContext(() => {}));
    }
    assert.equal(fetched, false, 'no Graph call without configuration');
    assert.equal(statements.length, 0, 'no database work without configuration');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the scheduled handler polls Graph and flags when configuration is present', async () => {
  const originalFetch = globalThis.fetch;
  resetTokenCache();
  const { db, accounts } = createFakeD1();
  const waited: Promise<unknown>[] = [];
  stubGraphFetch((url) => {
    assert.equal(url.searchParams.get('$orderby'), 'receivedDateTime asc');
    return graphJson({
      value: [
        {
          id: 'AAMkAD_1',
          subject: 'Refund request',
          from: { emailAddress: { name: 'Ada', address: 'Ada@Example.com' } },
          toRecipients: [{ emailAddress: { address: 'support@example.com' } }],
          receivedDateTime: '2026-08-30T10:15:00Z',
          webLink: 'https://outlook.office365.com/owa/?ItemID=AAMkAD_1',
          bodyPreview: 'PRIVATE BODY TEXT',
        },
      ],
    });
  });
  try {
    // No STRIPE_SECRET_KEY, so the poll never asks Stripe — the only other
    // host stubGraphFetch would reject.
    await worker.scheduled(
      scheduledEvent(),
      { ...GRAPH_ENV, DB: db },
      scheduledContext((promise) => waited.push(promise))
    );

    const account = accounts.get('ada@example.com');
    assert.equal(account?.flagged, 1);
    assert.equal(account?.flag_reason, 'refund-mention');
    assert.equal(account?.flag_subject, 'Refund request');
    assert.equal(account?.stripe_customer_id, null);
    assert.equal(waited.length, 1, 'the poll is registered with the runtime');
    assert.ok(!JSON.stringify([...accounts.values()]).includes('PRIVATE BODY TEXT'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the scheduled handler logs the summary the setup doc tells operators to look for', async () => {
  // docs/office365-mail-setup.md says to "check the Worker's cron invocation
  // log" when flags stop appearing. Without this line a successful run writes
  // nothing, so a poller stalled on its watermark and a quiet mailbox look
  // identical from the dashboard.
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  resetTokenCache();
  const { db } = createFakeD1();
  const logged: string[] = [];
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  stubGraphFetch(() => graphJson({ value: [] }));
  try {
    await worker.scheduled(scheduledEvent(), { ...GRAPH_ENV, DB: db }, scheduledContext(() => {}));
    assert.equal(logged.length, 1);
    assert.match(logged[0], /"fetched":0/);
    assert.match(logged[0], /"flagged":0/);
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }
});

test('ADMIN_HTML includes every element id the script depends on', () => {
  for (const id of [
    'token',
    'account-search',
    'flagged-only',
    'refresh-accounts',
    'accounts-status',
    'accounts',
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

test('the accounts UI defaults to flagged-only and sits above the customer search', () => {
  assert.match(
    ADMIN_HTML,
    /<input id="flagged-only" type="checkbox" checked \/>/,
    'the flagged queue is the default view, so the checkbox ships checked'
  );
  assert.ok(
    ADMIN_HTML.indexOf('id="account-search"') < ADMIN_HTML.indexOf('id="search-input"'),
    'the Accounts section belongs above the existing customer search'
  );
  // The accounts list loads itself on page open, so the likeliest 500 an
  // operator ever sees here is the accounts table not existing yet. That comes
  // back as plain text, and an unguarded parse would report it as a JSON
  // syntax error instead of the missing migration.
  assert.match(ADMIN_HTML, /migration has been applied/);
  assert.match(ADMIN_HTML, /response\.json\(\)\.catch\(/);
  // The page is one template literal: a backtick or ${ inside it would end the
  // string or interpolate, so the whole admin page is built with concatenation.
  assert.ok(!ADMIN_HTML.includes('`'));
  assert.ok(!ADMIN_HTML.includes('${'));
  // Data reaches the DOM through textContent/value only. innerHTML appears
  // solely to empty a container before rebuilding it from created elements.
  for (const assignment of ADMIN_HTML.match(/innerHTML\s*=\s*[^;]*/g) || []) {
    assert.equal(
      assignment.replace(/\s+/g, ' ').trim(),
      "innerHTML = ''",
      'innerHTML may only ever be assigned the empty string, never data'
    );
  }
});
