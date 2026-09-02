import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GraphApiError,
  getAccessToken,
  shapeMessage,
  listCorrespondence,
  listRecentMessages,
  resetTokenCache,
} from '../src/graph';

const CLIENT_SECRET = 'super-secret-client-value';

const ENV = {
  GRAPH_TENANT_ID: 'tenant-abc',
  GRAPH_CLIENT_ID: 'client-abc',
  GRAPH_CLIENT_SECRET: CLIENT_SECRET,
  GRAPH_MAILBOX: 'support@example.com',
};

const originalFetch = globalThis.fetch;

/** The init type `globalThis.fetch` is declared with, so a stub stays assignable to it. */
type FetchInit = RequestInit<RequestInitCfProperties>;

interface FetchCall {
  url: URL;
  init: FetchInit | undefined;
}

type StubHandler = (url: URL, init: FetchInit | undefined, callNumber: number) => Response;

/** `fetch` may be handed a string, a Request, or a URL; all three reach these stubs. */
function toUrl(input: RequestInfo | URL): URL {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

/**
 * `init.headers` is a union of Headers, a record, and iterable pairs, and cannot be
 * indexed as it stands. The record branch stays an exact, case-sensitive read: the
 * assertions this feeds replaced a direct `init.headers.Authorization`, and
 * normalising every branch through `Headers` would quietly start accepting a
 * differently-cased header name that the old assertion would have failed on.
 */
function headerValue(init: FetchInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Symbol.iterator in headers) {
    for (const pair of headers) {
      const [key, value] = [...pair];
      if (key === name) return value;
    }
    return undefined;
  }
  return headers[name];
}

/** The token request sends URLSearchParams; narrow to it rather than asserting a type. */
function formBody(init: FetchInit | undefined): URLSearchParams {
  const body = init?.body;
  if (!(body instanceof URLSearchParams)) {
    throw new Error('expected the token request to send a URLSearchParams body');
  }
  return body;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function tokenResponse(expiresIn = 3600): Response {
  return jsonResponse({ access_token: 'graph-token', token_type: 'Bearer', expires_in: expiresIn });
}

/**
 * Routes stubbed requests by hostname rather than by call index: the module-scope
 * token cache changes how many requests a call makes, so index-based assertions
 * would be order-dependent.
 */
function stubFetch({ token, graph }: { token?: StubHandler; graph: StubHandler }): {
  token: FetchCall[];
  graph: FetchCall[];
} {
  const calls: { token: FetchCall[]; graph: FetchCall[] } = { token: [], graph: [] };
  globalThis.fetch = async (input: RequestInfo | URL, init?: FetchInit) => {
    const url = toUrl(input);
    if (url.hostname === 'login.microsoftonline.com') {
      calls.token.push({ url, init });
      return token ? token(url, init, calls.token.length) : tokenResponse();
    }
    if (url.hostname === 'graph.microsoft.com') {
      calls.graph.push({ url, init });
      return graph(url, init, calls.graph.length);
    }
    throw new Error('Unexpected fetch to ' + url.href);
  };
  return calls;
}

const MESSAGE_FROM_GRAPH = {
  id: 'AAMkAD_1',
  subject: 'Refund request',
  from: { emailAddress: { name: 'Person Example', address: 'person@example.com' } },
  toRecipients: [{ emailAddress: { name: 'Support', address: 'support@example.com' } }],
  receivedDateTime: '2026-08-30T10:15:00Z',
  webLink: 'https://outlook.office365.com/owa/?ItemID=AAMkAD_1',
  conversationId: 'conv_1',
  hasAttachments: false,
};

test('shapeMessage keeps only whitelisted metadata and never leaks message content', () => {
  const shaped = shapeMessage({
    ...MESSAGE_FROM_GRAPH,
    body: { contentType: 'html', content: '<p>my bank details are 1234</p>' },
    bodyPreview: 'my bank details are 1234',
    internetMessageHeaders: [{ name: 'X-Secret', value: 'leak' }],
    isRead: true,
    ccRecipients: [{ emailAddress: { address: 'cc@example.com' } }],
  });

  // deepEqual (not just a `body` check) so ANY unexpected passthrough fails here.
  assert.deepEqual(shaped, {
    id: 'AAMkAD_1',
    subject: 'Refund request',
    from: { name: 'Person Example', address: 'person@example.com' },
    toRecipients: [{ name: 'Support', address: 'support@example.com' }],
    receivedDateTime: '2026-08-30T10:15:00Z',
    webLink: 'https://outlook.office365.com/owa/?ItemID=AAMkAD_1',
    conversationId: 'conv_1',
    hasAttachments: false,
  });

  assert.equal('body' in shaped, false);
  assert.equal('bodyPreview' in shaped, false);
  assert.ok(!JSON.stringify(shaped).includes('bank details'));
});

test('shapeMessage tolerates a message with no sender or recipients', () => {
  const shaped = shapeMessage({ id: 'AAMkAD_2', subject: null, receivedDateTime: '2026-08-30T10:15:00Z' });
  assert.equal(shaped.from, null);
  assert.deepEqual(shaped.toRecipients, []);
});

test('listCorrespondence searches participants in the env mailbox and shapes the results', async () => {
  resetTokenCache();
  const calls = stubFetch({
    graph: (url) => {
      assert.equal(url.pathname, '/v1.0/users/support%40example.com/messages');
      assert.equal(url.searchParams.get('$search'), '"participants:person@example.com"');
      assert.equal(
        url.searchParams.get('$select'),
        'id,subject,from,toRecipients,receivedDateTime,webLink,conversationId,hasAttachments',
      );
      assert.equal(url.searchParams.get('$top'), '25');
      // $search on messages cannot be combined with $orderby.
      assert.equal(url.searchParams.get('$orderby'), null);
      return jsonResponse({ value: [{ ...MESSAGE_FROM_GRAPH, bodyPreview: 'should not survive' }] });
    },
  });
  try {
    const result = await listCorrespondence(ENV, 'person@example.com');
    assert.equal(result.mode, 'search');
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].subject, 'Refund request');
    assert.ok(!JSON.stringify(result).includes('should not survive'));
    assert.equal(calls.graph.length, 1);
    assert.equal(headerValue(calls.graph[0].init, 'Authorization'), 'Bearer graph-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listCorrespondence reuses one access token across calls', async () => {
  resetTokenCache();
  const calls = stubFetch({
    graph: () => jsonResponse({ value: [] }),
  });
  try {
    await listCorrespondence(ENV, 'person@example.com');
    await listCorrespondence(ENV, 'other@example.com');
    assert.equal(calls.token.length, 1, 'the token should be fetched once and cached');
    assert.equal(calls.graph.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('concurrent token requests share a single in-flight fetch', async () => {
  resetTokenCache();
  const calls = stubFetch({ graph: () => jsonResponse({ value: [] }) });
  try {
    const tokens = await Promise.all([getAccessToken(ENV), getAccessToken(ENV), getAccessToken(ENV)]);
    assert.deepEqual(tokens, ['graph-token', 'graph-token', 'graph-token']);
    assert.equal(calls.token.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an expired cached token is refetched rather than reused', async () => {
  resetTokenCache();
  // expires_in below the 300s safety margin means the token is already stale.
  const calls = stubFetch({ token: () => tokenResponse(60), graph: () => jsonResponse({ value: [] }) });
  try {
    await getAccessToken(ENV);
    await getAccessToken(ENV);
    assert.equal(calls.token.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('concurrent callers arriving on a stale token still make one refresh request', async () => {
  resetTokenCache();
  // First token is already past its usable life; the refresh must not fan out.
  const calls = stubFetch({
    token: (url, init, callNumber) => tokenResponse(callNumber === 1 ? 60 : 3600),
    graph: () => jsonResponse({ value: [] }),
  });
  try {
    await getAccessToken(ENV);
    assert.equal(calls.token.length, 1);
    await Promise.all([getAccessToken(ENV), getAccessToken(ENV), getAccessToken(ENV)]);
    assert.equal(calls.token.length, 2, 'a refresh must be shared, not repeated per caller');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listCorrespondence falls back to a sender-only filter when $search is refused', async () => {
  resetTokenCache();
  const calls = stubFetch({
    graph: (url) => {
      if (url.searchParams.has('$search')) {
        return jsonResponse({ error: { code: 'BadRequest', message: 'Search is not supported' } }, 400);
      }
      assert.equal(url.pathname, '/v1.0/users/support%40example.com/messages');
      assert.equal(url.searchParams.get('$filter'), "from/emailAddress/address eq 'person@example.com'");
      assert.equal(url.searchParams.get('$orderby'), 'receivedDateTime desc');
      assert.equal(url.searchParams.get('$top'), '25');
      return jsonResponse({ value: [MESSAGE_FROM_GRAPH] });
    },
  });
  try {
    const result = await listCorrespondence(ENV, 'person@example.com');
    assert.equal(result.mode, 'sender-only');
    assert.equal(result.messages.length, 1);
    assert.equal(calls.graph.length, 2);
    assert.ok(calls.graph[0].url.searchParams.has('$search'));
    assert.ok(calls.graph[1].url.searchParams.has('$filter'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listCorrespondence also falls back when $search is forbidden (403)', async () => {
  resetTokenCache();
  stubFetch({
    graph: (url) => {
      if (url.searchParams.has('$search')) {
        return jsonResponse({ error: { code: 'ErrorAccessDenied', message: 'Access denied' } }, 403);
      }
      return jsonResponse({ value: [] });
    },
  });
  try {
    const result = await listCorrespondence(ENV, 'person@example.com');
    assert.equal(result.mode, 'sender-only');
    assert.deepEqual(result.messages, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listCorrespondence propagates a non-400/403 Graph failure instead of falling back', async () => {
  resetTokenCache();
  const calls = stubFetch({
    graph: () => jsonResponse({ error: { code: 'TooManyRequests', message: 'Throttled' } }, 429),
  });
  try {
    await assert.rejects(
      () => listCorrespondence(ENV, 'person@example.com'),
      (error) => error instanceof GraphApiError && error.status === 429,
    );
    assert.equal(calls.graph.length, 1, 'a throttled request must not trigger the fallback');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listCorrespondence escapes an OData single quote in the address by doubling it', async () => {
  resetTokenCache();
  const calls = stubFetch({
    graph: (url) => {
      if (url.searchParams.has('$search')) return jsonResponse({ error: { message: 'nope' } }, 400);
      return jsonResponse({ value: [] });
    },
  });
  try {
    await listCorrespondence(ENV, "o'brien@example.com");
    assert.equal(
      calls.graph[1].url.searchParams.get('$filter'),
      "from/emailAddress/address eq 'o''brien@example.com'",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listCorrespondence reads only env.GRAPH_MAILBOX and refuses to run without it', async () => {
  resetTokenCache();
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return jsonResponse({ value: [] });
  };
  try {
    await assert.rejects(
      () => listCorrespondence({ ...ENV, GRAPH_MAILBOX: undefined }, 'person@example.com'),
      /GRAPH_MAILBOX is required/,
    );
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a failed token request throws GraphApiError carrying the AADSTS code, never the secret', async () => {
  resetTokenCache();
  stubFetch({
    token: () =>
      jsonResponse(
        {
          error: 'invalid_client',
          error_description:
            'AADSTS7000215: Invalid client secret provided: ' + CLIENT_SECRET + '. Trace ID: abc',
        },
        401,
      ),
    graph: () => {
      throw new Error('Graph must not be called without a token');
    },
  });
  try {
    await assert.rejects(
      () => listCorrespondence(ENV, 'person@example.com'),
      (error) => {
        assert.ok(error instanceof GraphApiError);
        assert.equal(error.status, 401);
        assert.match(error.message, /AADSTS7000215/);
        assert.ok(
          !error.message.includes(CLIENT_SECRET),
          'the client secret must never appear in a thrown message',
        );
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a token failure is not cached — the next call retries', async () => {
  resetTokenCache();
  const calls = stubFetch({
    token: (url, init, callNumber) =>
      callNumber === 1
        ? jsonResponse({ error_description: 'AADSTS900023: tenant not found' }, 400)
        : tokenResponse(),
    graph: () => jsonResponse({ value: [] }),
  });
  try {
    await assert.rejects(() => getAccessToken(ENV), GraphApiError);
    assert.equal(await getAccessToken(ENV), 'graph-token');
    assert.equal(calls.token.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the token request uses the client credentials grant against the configured tenant', async () => {
  resetTokenCache();
  const calls = stubFetch({ graph: () => jsonResponse({ value: [] }) });
  try {
    await getAccessToken(ENV);
    const { url, init } = calls.token[0];
    const body = formBody(init);
    assert.equal(url.pathname, '/tenant-abc/oauth2/v2.0/token');
    assert.equal(init?.method, 'POST');
    assert.equal(headerValue(init, 'content-type'), 'application/x-www-form-urlencoded');
    assert.equal(body.get('grant_type'), 'client_credentials');
    assert.equal(body.get('scope'), 'https://graph.microsoft.com/.default');
    assert.equal(body.get('client_id'), 'client-abc');
    assert.equal(body.get('client_secret'), CLIENT_SECRET);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listRecentMessages polls the env mailbox from the watermark, oldest first', async () => {
  resetTokenCache();
  const calls = stubFetch({
    graph: (url) => {
      // Inbox only. /users/{id}/messages spans Sent Items, so the team's own
      // replies would flag the support mailbox as an account on every thread.
      assert.equal(url.pathname, '/v1.0/users/support%40example.com/mailFolders/inbox/messages');
      // `ge`, not `gt`: receivedDateTime is second-granularity, so a strict
      // comparison would drop a message sharing the boundary second. The
      // re-fetched boundary message is skipped by processed_messages instead.
      assert.equal(url.searchParams.get('$filter'), 'receivedDateTime ge 2026-08-30T10:15:00.000Z');
      assert.equal(url.searchParams.get('$orderby'), 'receivedDateTime asc');
      // The same whitelist as every other call — no body, no bodyPreview.
      assert.equal(
        url.searchParams.get('$select'),
        'id,subject,from,toRecipients,receivedDateTime,webLink,conversationId,hasAttachments',
      );
      assert.equal(url.searchParams.get('$top'), '50');
      assert.equal(url.searchParams.get('$search'), null);
      return jsonResponse({ value: [{ ...MESSAGE_FROM_GRAPH, bodyPreview: 'PRIVATE BODY TEXT' }] });
    },
  });
  try {
    const messages = await listRecentMessages(ENV, '2026-08-30T10:15:00Z');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].subject, 'Refund request');
    assert.deepEqual(messages[0].from, { name: 'Person Example', address: 'person@example.com' });
    assert.ok(!JSON.stringify(messages).includes('PRIVATE BODY TEXT'), 'the poller sees metadata only');
    assert.equal(calls.graph.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listRecentMessages asks for immutable ids so a filed message keeps its idempotency key', async () => {
  resetTokenCache();
  // Graph message ids are not stable by default: filing a message into a folder
  // reassigns the id. Idempotency is keyed on that id, so without this header an
  // operator who clears a flag and then files the mail gets it flagged again on
  // the next poll — which the README explicitly promises cannot happen.
  const calls = stubFetch({ graph: () => jsonResponse({ value: [] }) });
  try {
    await listRecentMessages(ENV, '2026-08-30T10:15:00Z');
    assert.equal(headerValue(calls.graph[0].init, 'Prefer'), 'IdType="ImmutableId"');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listCorrespondence still reads the whole mailbox, not just the inbox', async () => {
  resetTokenCache();
  // The poller is inbox-scoped on purpose; the correspondence panel must not be.
  // An operator looking at a customer wants both sides of the thread, so Sent
  // Items has to stay in scope here.
  const calls = stubFetch({ graph: () => jsonResponse({ value: [] }) });
  try {
    await listCorrespondence(ENV, 'person@example.com');
    assert.equal(calls.graph[0].url.pathname, '/v1.0/users/support%40example.com/messages');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listRecentMessages honours an explicit limit and tolerates an empty mailbox', async () => {
  resetTokenCache();
  const calls = stubFetch({ graph: () => jsonResponse({}) });
  try {
    assert.deepEqual(await listRecentMessages(ENV, '2026-08-30T10:15:00Z', 5), []);
    assert.equal(calls.graph[0].url.searchParams.get('$top'), '5');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listRecentMessages rejects a watermark that is not a date, before calling Graph', async () => {
  resetTokenCache();
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return jsonResponse({ value: [] });
  };
  try {
    // Only a canonical ISO timestamp can ever be concatenated into $filter. The
    // casts are the point of the test: the watermark reaches this function from
    // a D1 row, so the declared `string` is a claim the runtime must not trust.
    const notDates = ["2026-01-01' or startswith(subject,'a", 'not-a-date', '', null, undefined];
    for (const bad of notDates) {
      await assert.rejects(() => listRecentMessages(ENV, bad as unknown as string), /sinceIso must be a valid date/);
    }
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('listRecentMessages reads only env.GRAPH_MAILBOX and refuses to run without it', async () => {
  resetTokenCache();
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return jsonResponse({ value: [] });
  };
  try {
    await assert.rejects(
      () => listRecentMessages({ ...ENV, GRAPH_MAILBOX: undefined }, '2026-08-30T10:15:00Z'),
      /GRAPH_MAILBOX is required/,
    );
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('graphRequest surfaces a non-JSON Graph response as GraphApiError', async () => {
  resetTokenCache();
  stubFetch({
    graph: () => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
  });
  try {
    await assert.rejects(
      () => listCorrespondence(ENV, 'person@example.com'),
      (error) => error instanceof GraphApiError && error.status === 502,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
