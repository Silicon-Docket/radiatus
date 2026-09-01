const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';
const LOGIN_BASE = 'https://login.microsoftonline.com';

// Refresh a little before the token actually expires so an in-flight request
// never races the expiry. The lifetime itself always comes from the token
// response — never hardcoded, never read out of the JWT.
const TOKEN_EXPIRY_SKEW_SECONDS = 300;

// The only message fields this integration ever asks Graph for. Kept in lockstep
// with shapeMessage(): $select is the request-side half of the same whitelist.
const MESSAGE_FIELDS = [
  'id',
  'subject',
  'from',
  'toRecipients',
  'receivedDateTime',
  'webLink',
  'conversationId',
  'hasAttachments',
].join(',');

const MESSAGE_LIMIT = 25;

// One poll's worth of backlog. A run that hits this ceiling simply leaves the
// remainder for the next tick: the watermark only advances past messages that
// were actually recorded, so nothing is skipped, it just arrives a cron later.
const POLL_LIMIT = 50;

export class GraphApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GraphApiError';
    this.status = status;
  }
}

/**
 * Belt-and-braces: we never interpolate the client secret into a message
 * ourselves, but Microsoft's error_description can quote back what was sent
 * (AADSTS7000215 does exactly that for a bad secret). Strip it either way so a
 * thrown GraphApiError can never carry the credential into a log line.
 */
function redactSecret(message, secret) {
  if (!secret || !message) return message;
  return String(message).split(secret).join('[redacted]');
}

/**
 * Cached at module scope as a *promise*, not a value, so concurrent requests
 * share one in-flight token fetch instead of each starting their own.
 */
let tokenPromise = null;

/** Test-only escape hatch: the module-scope cache otherwise leaks across tests. */
export function resetTokenCache() {
  tokenPromise = null;
}

async function requestAccessToken(env) {
  const url = LOGIN_BASE + '/' + encodeURIComponent(env.GRAPH_TENANT_ID) + '/oauth2/v2.0/token';
  const body = new URLSearchParams({
    client_id: env.GRAPH_CLIENT_ID,
    client_secret: env.GRAPH_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  let data;
  try {
    data = await response.json();
  } catch {
    throw new GraphApiError(response.status, 'Invalid response from the Microsoft identity platform');
  }

  if (!response.ok) {
    // error_description is where the AADSTS code lives, and that code is the
    // single most useful thing for an adopter debugging their tenant setup.
    const detail = data.error_description || data.error || 'Microsoft identity platform error';
    throw new GraphApiError(response.status, redactSecret(detail, env.GRAPH_CLIENT_SECRET));
  }

  const lifetimeSeconds = Number(data.expires_in);
  const usableSeconds = Number.isFinite(lifetimeSeconds) ? lifetimeSeconds - TOKEN_EXPIRY_SKEW_SECONDS : 0;
  return {
    accessToken: data.access_token,
    expiresAtMs: Date.now() + Math.max(usableSeconds, 0) * 1000,
  };
}

export async function getAccessToken(env) {
  // Loops rather than recurses. Each pass either returns a live token, adopts a
  // replacement another caller installed while we were awaiting, or evicts the
  // entry we ourselves found stale. The adoption case is what keeps a *refresh*
  // single-flight too: without it, N callers arriving on an expired token would
  // each start their own request.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const cached = tokenPromise;
    if (!cached) break;

    let token = null;
    try {
      token = await cached;
    } catch {
      // A failed lookup is never worth caching; fall through and try again.
    }
    if (token && token.expiresAtMs > Date.now()) return token.accessToken;

    if (tokenPromise === cached) {
      tokenPromise = null;
      break;
    }
    // Someone else already replaced it; take theirs on the next pass.
  }

  if (!tokenPromise) {
    const pending = requestAccessToken(env);
    tokenPromise = pending;
    // Drop a rejected attempt from the cache so the next call retries rather than
    // replaying the same failure until the isolate is recycled.
    pending.catch(() => {
      if (tokenPromise === pending) tokenPromise = null;
    });
  }

  const token = await tokenPromise;
  return token.accessToken;
}

export async function graphRequest(env, path, params = {}, extraHeaders = {}) {
  const accessToken = await getAccessToken(env);
  const url = new URL(GRAPH_API_BASE + path);
  for (const [key, value] of Object.entries(params)) {
    // URLSearchParams percent-encodes for us; encoding here too would double-encode.
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    headers: { Authorization: 'Bearer ' + accessToken, ...extraHeaders },
  });

  let data;
  try {
    data = await response.json();
  } catch {
    throw new GraphApiError(response.status, 'Invalid response from Microsoft Graph');
  }

  if (!response.ok) {
    throw new GraphApiError(response.status, data.error?.message || 'Microsoft Graph error');
  }
  return data;
}

/**
 * SECURITY BOUNDARY. This is an explicit allow-list, not a deny-list: only the
 * metadata fields named below ever leave this module. `body` and `bodyPreview`
 * are not omitted by oversight — excluding message content is the whole premise
 * of this integration, and this function is the code-side half of that promise
 * (the Exchange `Application Mail.ReadBasic` grant is the other half).
 * Do not add a field here without deciding it is safe to expose to anyone
 * holding ADMIN_API_TOKEN.
 */
export function shapeMessage(message) {
  return {
    id: message.id,
    subject: message.subject,
    from: message.from ? shapeParticipant(message.from) : null,
    toRecipients: (message.toRecipients || []).map(shapeParticipant),
    receivedDateTime: message.receivedDateTime,
    webLink: message.webLink,
    conversationId: message.conversationId,
    hasAttachments: message.hasAttachments,
  };
}

function shapeParticipant(participant) {
  const emailAddress = participant?.emailAddress || {};
  return { name: emailAddress.name, address: emailAddress.address };
}

/** OData string literals are single-quoted; a literal quote is escaped by doubling it. */
function escapeODataString(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * The $search value is a quoted KQL string, so a double quote in the address
 * would end the term early and let the rest of it become query syntax. The blast
 * radius is limited to this one mailbox, but drop the characters anyway.
 */
function escapeSearchTerm(value) {
  return String(value).replace(/["\\]/g, '');
}

/**
 * Lists message metadata involving `address` in the single mailbox named by
 * env.GRAPH_MAILBOX. The mailbox is deliberately not a parameter: making it one
 * would turn a caller holding ADMIN_API_TOKEN into a tenant-wide mailbox browser.
 *
 * Returns { messages, mode }. `mode` is 'search' when Graph's $search ran, and
 * 'sender-only' when it was refused and we fell back to filtering on sender —
 * a view that shows what the customer sent but not what was replied.
 */
export async function listCorrespondence(env, address) {
  if (!env.GRAPH_MAILBOX) throw new Error('GRAPH_MAILBOX is required');
  const participant = (address || '').trim();
  if (!participant) throw new Error('address is required');

  const path = '/users/' + encodeURIComponent(env.GRAPH_MAILBOX) + '/messages';

  try {
    const searched = await graphRequest(env, path, {
      // $search on messages cannot be combined with $orderby; Graph returns 400.
      $search: '"participants:' + escapeSearchTerm(participant) + '"',
      $select: MESSAGE_FIELDS,
      $top: MESSAGE_LIMIT,
    });
    return { messages: (searched.value || []).map(shapeMessage), mode: 'search' };
  } catch (error) {
    // It is not verified whether $search is permitted under an Exchange RBAC
    // `Application Mail.ReadBasic` grant. A refusal (400 malformed/unsupported,
    // 403 not permitted) degrades to sender-only rather than failing the panel.
    // Anything else — auth, throttling, outage — is a real error and propagates.
    const refused = error instanceof GraphApiError && (error.status === 400 || error.status === 403);
    if (!refused) throw error;
  }

  const filtered = await graphRequest(env, path, {
    $filter: "from/emailAddress/address eq '" + escapeODataString(participant) + "'",
    $orderby: 'receivedDateTime desc',
    $select: MESSAGE_FIELDS,
    $top: MESSAGE_LIMIT,
  });
  return { messages: (filtered.value || []).map(shapeMessage), mode: 'sender-only' };
}

/**
 * Lists message metadata received at or after `sinceIso`, oldest first, from the
 * env.GRAPH_MAILBOX mailbox. This is the auto-flagging poller's view of the
 * mailbox; listCorrespondence() above is the operator's per-customer view. They
 * are separate exports because they ask different questions — but they share
 * graphRequest, MESSAGE_FIELDS and shapeMessage, so the metadata-only whitelist
 * is enforced in exactly one place for both.
 *
 * `ge`, not `gt`: receivedDateTime has second granularity and a support mailbox
 * does receive two messages in the same second. `gt` against a watermark taken
 * from the last message processed would silently drop the other one. `ge`
 * re-fetches the boundary message instead, and processed_messages skips it —
 * costing one wasted row per run and losing nothing.
 *
 * Returns an array of shaped messages.
 */
export async function listRecentMessages(env, sinceIso, limit = POLL_LIMIT) {
  if (!env.GRAPH_MAILBOX) throw new Error('GRAPH_MAILBOX is required');

  // The string check is not redundant: `new Date(null)` is not an invalid date,
  // it is midnight 1970 — so a null watermark slipping through here would ask
  // Graph for the mailbox's entire history rather than throwing.
  if (typeof sinceIso !== 'string' || !sinceIso.trim()) throw new Error('sinceIso must be a valid date');
  // Round-tripping through Date does two jobs: it rejects a malformed watermark
  // before it reaches Graph, and it means nothing but a canonical ISO timestamp
  // can ever be concatenated into $filter.
  const since = new Date(sinceIso);
  if (Number.isNaN(since.getTime())) throw new Error('sinceIso must be a valid date');

  // Inbox only, unlike listCorrespondence which reads the whole mailbox on
  // purpose (an operator wants both sides of a thread). The poller must not:
  // /users/{id}/messages spans Sent Items, so the team's own "Re: refund
  // request" reply is a message whose sender is the support mailbox, and every
  // answered thread would permanently self-flag the mailbox to the top of the
  // queue. Deleted Items is excluded for the same reason — deleting mail should
  // stop it flagging.
  const path = '/users/' + encodeURIComponent(env.GRAPH_MAILBOX) + '/mailFolders/inbox/messages';
  const result = await graphRequest(
    env,
    path,
    {
      $filter: 'receivedDateTime ge ' + since.toISOString(),
      // Same property as the filter, so this is not the cross-property sort that
      // Exchange rejects as "too complex" (see docs/office365-mail-setup.md).
      $orderby: 'receivedDateTime asc',
      $select: MESSAGE_FIELDS,
      $top: limit,
    },
    // Graph message ids are NOT stable by default — filing a message into a
    // folder reassigns its id. Idempotency here is keyed on that id, so without
    // this header an operator who clears a flag and then files the mail gets the
    // flag raised again on the next poll. This asks for the immutable form.
    { Prefer: 'IdType="ImmutableId"' }
  );
  return (result.value || []).map(shapeMessage);
}
