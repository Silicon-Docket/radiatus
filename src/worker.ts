import { lookupStripeRecord, StripeApiError } from './stripe';
import { listCorrespondence, GraphApiError } from './graph';
import { pollAndFlag } from './flagging';
import { isGraphConfigured, isStripeConfigured, type Env } from './types';

export const ADMIN_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Radiatus Admin</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 960px; }
      form, table { margin-top: 1rem; width: 100%; }
      input, textarea, button { padding: 0.5rem; margin: 0.25rem 0; width: 100%; box-sizing: border-box; }
      table { border-collapse: collapse; }
      th, td { border: 1px solid #ddd; padding: 0.5rem; text-align: left; vertical-align: top; }
      .row { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
      .muted { color: #555; font-size: 0.9rem; }
      .error { color: #b00020; }
      input[type="checkbox"] { width: auto; margin: 0 0.4rem 0 0; }
      .check { display: flex; align-items: center; padding: 0.5rem 0; }
      .linkish { width: auto; background: none; border: 0; padding: 0; color: #0b57d0; text-decoration: underline; cursor: pointer; text-align: left; }
    </style>
  </head>
  <body>
    <h1>Radiatus: Stripe Subscription CRM</h1>
    <p class="muted">Search a customer by email, or a Stripe customer/subscription ID, to see their live status and attach notes.</p>

    <label>Admin API Token</label>
    <input id="token" type="password" placeholder="Paste ADMIN_API_TOKEN" />

    <h2>Accounts</h2>
    <p class="muted">
      Accounts flagged automatically from the shared support mailbox. Flag rules see the
      message <strong>subject and sender only</strong> &mdash; message bodies are never
      fetched, by design. Edit <code>src/flag-rules.ts</code> to change what raises a flag.
      Click an email to look that customer up below.
    </p>

    <div class="row">
      <div>
        <label>Search accounts</label>
        <input id="account-search" placeholder="email or cus_..." />
      </div>
      <div>
        <label>&nbsp;</label>
        <div class="check">
          <input id="flagged-only" type="checkbox" checked />
          <label for="flagged-only">Show flagged only</label>
        </div>
      </div>
      <div>
        <label>&nbsp;</label>
        <button id="refresh-accounts" type="button">Refresh accounts</button>
      </div>
    </div>

    <p id="accounts-status" class="muted"></p>
    <table>
      <thead>
        <tr><th>Email</th><th>Stripe customer</th><th>Flag reason</th><th>Subject</th><th>Flagged</th><th>Actions</th></tr>
      </thead>
      <tbody id="accounts"></tbody>
    </table>

    <h2>Customer lookup</h2>
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

      <h2>Correspondence</h2>
      <p class="muted">
        Message metadata from the shared Office 365 mailbox &mdash; dates, participants, and
        subjects only. Message bodies are never fetched; open a message in Outlook to read it.
        Optional feature: see docs/office365-mail-setup.md.
      </p>
      <button id="load-mail" type="button">Load correspondence</button>
      <p id="mail-status" class="muted"></p>
      <table>
        <thead>
          <tr><th>Received</th><th>From</th><th>Subject</th><th>Link</th></tr>
        </thead>
        <tbody id="messages"></tbody>
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
      const loadMailButton = document.getElementById('load-mail');
      const mailStatus = document.getElementById('mail-status');
      const messagesBody = document.getElementById('messages');
      const accountSearchInput = document.getElementById('account-search');
      const flaggedOnlyCheckbox = document.getElementById('flagged-only');
      const refreshAccountsButton = document.getElementById('refresh-accounts');
      const accountsStatus = document.getElementById('accounts-status');
      const accountsBody = document.getElementById('accounts');

      let currentCustomerId = null;
      let currentCustomerEmail = null;

      const authHeaders = () => ({
        'Content-Type': 'application/json',
        'Authorization': 'Token ' + tokenNode.value.trim(),
      });

      function setStatus(message) {
        statusNode.textContent = message;
        errorNode.textContent = '';
      }

      function setError(message) {
        statusNode.textContent = '';
        errorNode.textContent = message;
      }

      function formatMoney(amount, currency) {
        return (amount / 100).toFixed(2) + ' ' + currency.toUpperCase();
      }

      function formatDate(unixSeconds) {
        return new Date(unixSeconds * 1000).toLocaleDateString();
      }

      function formatTimestamp(isoString) {
        if (!isoString) return '';
        const parsed = new Date(isoString);
        return Number.isNaN(parsed.getTime()) ? isoString : parsed.toLocaleString();
      }

      function renderAccountRow(account) {
        const tr = document.createElement('tr');

        // The email is the route out of the flagged queue and into the
        // troubleshooting view below, so it is a control, not just text.
        const emailCell = document.createElement('td');
        const emailButton = document.createElement('button');
        emailButton.type = 'button';
        emailButton.className = 'linkish';
        emailButton.textContent = account.email;
        emailButton.addEventListener('click', () => {
          searchInput.value = account.email;
          runSearch();
        });
        emailCell.appendChild(emailButton);

        const customerCell = document.createElement('td');
        // Null means the sender is not a known Stripe customer, or Stripe was
        // unreachable when the flag was raised. Say so rather than showing a blank.
        customerCell.textContent = account.stripe_customer_id || 'not a Stripe customer';

        const reasonCell = document.createElement('td');
        reasonCell.textContent = account.flag_reason || '';

        const subjectCell = document.createElement('td');
        subjectCell.textContent = account.flag_subject || '';

        const whenCell = document.createElement('td');
        whenCell.textContent = formatTimestamp(account.last_flagged_at);

        const actionsCell = document.createElement('td');
        if (account.flagged) {
          const clearButton = document.createElement('button');
          clearButton.type = 'button';
          clearButton.textContent = 'Clear flag';
          clearButton.addEventListener('click', async () => {
            try {
              clearButton.disabled = true;
              const response = await fetch('/api/accounts/resolve', {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({ email: account.email }),
              });
              const data = await response.json();
              if (!response.ok) {
                throw new Error(data.error || 'Failed to clear the flag');
              }
              setStatus('Cleared the flag on ' + account.email);
              await loadAccounts();
            } catch (error) {
              clearButton.disabled = false;
              setError(error.message);
            }
          });
          actionsCell.appendChild(clearButton);
        } else {
          actionsCell.textContent = 'cleared';
        }

        tr.appendChild(emailCell);
        tr.appendChild(customerCell);
        tr.appendChild(reasonCell);
        tr.appendChild(subjectCell);
        tr.appendChild(whenCell);
        tr.appendChild(actionsCell);
        return tr;
      }

      async function loadAccounts() {
        try {
          accountsStatus.textContent = 'Loading accounts...';
          const params = new URLSearchParams({
            q: accountSearchInput.value.trim(),
            flaggedOnly: flaggedOnlyCheckbox.checked ? 'true' : 'false',
          });
          const response = await fetch('/api/accounts?' + params.toString(), {
            headers: authHeaders(),
          });
          if (response.status === 401) {
            // The page loads this list before anyone has typed a token, so a
            // missing token is the normal first state, not a red error.
            accountsBody.innerHTML = '';
            accountsStatus.textContent = 'Paste your admin API token above to load flagged accounts.';
            return;
          }
          // Not every failure here is JSON. An unhandled exception in the
          // Worker — overwhelmingly likely to be "no such table: accounts"
          // because the migration has not been applied yet — comes back as a
          // plain-text 500, and this list loads itself on page open, so an
          // unguarded parse would greet the operator with a JSON syntax error
          // instead of the actual problem.
          const data = await response.json().catch(() => null);
          if (!response.ok || !data) {
            throw new Error(
              (data && data.error) ||
                'Failed to load accounts (HTTP ' + response.status + '). If this deployment was ' +
                'just upgraded, check that the database migration has been applied — see the README.'
            );
          }
          accountsBody.innerHTML = '';
          for (const account of data.accounts) {
            accountsBody.appendChild(renderAccountRow(account));
          }
          if (data.accounts.length > 0) {
            accountsStatus.textContent = 'Showing ' + data.accounts.length + ' account(s).';
          } else if (flaggedOnlyCheckbox.checked) {
            accountsStatus.textContent = 'No flagged accounts. Nothing needs attention.';
          } else {
            accountsStatus.textContent = 'No accounts recorded yet.';
          }
        } catch (error) {
          accountsStatus.textContent = '';
          setError(error.message);
        }
      }

      function formatParticipant(participant) {
        if (!participant) return '';
        if (participant.name && participant.address) {
          return participant.name + ' <' + participant.address + '>';
        }
        return participant.address || participant.name || '';
      }

      function renderMessages(messages) {
        messagesBody.innerHTML = '';
        for (const message of messages) {
          const tr = document.createElement('tr');

          const receivedCell = document.createElement('td');
          receivedCell.textContent = formatTimestamp(message.receivedDateTime);

          const fromCell = document.createElement('td');
          fromCell.textContent = formatParticipant(message.from);

          const subjectCell = document.createElement('td');
          subjectCell.textContent = message.subject || '(no subject)';
          if (message.hasAttachments) {
            subjectCell.textContent = subjectCell.textContent + ' (has attachments)';
          }

          const linkCell = document.createElement('td');
          // Outlook stays the reader: the row links out, it never shows a body.
          // Only https links are honoured so a hostile webLink cannot smuggle in
          // a javascript: URL.
          if (typeof message.webLink === 'string' && message.webLink.startsWith('https://')) {
            const link = document.createElement('a');
            link.href = message.webLink;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = 'Open in Outlook';
            linkCell.appendChild(link);
          }

          tr.appendChild(receivedCell);
          tr.appendChild(fromCell);
          tr.appendChild(subjectCell);
          tr.appendChild(linkCell);
          messagesBody.appendChild(tr);
        }
      }

      // Loaded on click, not with the search: most lookups never need it, and a
      // Graph round trip per customer page view would be pure waste.
      async function loadMail() {
        const address = currentCustomerEmail;
        try {
          messagesBody.innerHTML = '';
          if (!address) {
            mailStatus.textContent = 'Search a customer with an email address first.';
            return;
          }
          mailStatus.textContent = 'Loading correspondence for ' + address + '...';
          const response = await fetch('/api/mail/lookup?q=' + encodeURIComponent(address), {
            headers: authHeaders(),
          });
          if (response.status === 501) {
            // Not an error: most deployments never set this feature up.
            mailStatus.textContent =
              'Office 365 mail lookup is not configured for this deployment. ' +
              'This feature is optional — see docs/office365-mail-setup.md to enable it.';
            return;
          }
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || 'Failed to load correspondence');
          }
          renderMessages(data.messages);
          if (data.messages.length === 0) {
            mailStatus.textContent = 'No messages found for ' + address + '.';
          } else if (data.mode === 'sender-only') {
            // Say what happened, not why. Graph rejects the participant search
            // with a 400 for several reasons and only one of them is "the grant
            // forbids it" — asserting the permissions story would send an
            // operator off to redo their Exchange RBAC over a malformed query.
            mailStatus.textContent =
              'Showing ' + data.messages.length + ' message(s) sent BY ' + address +
              '. Graph rejected the participant search for this mailbox, so replies sent to ' +
              address + ' are not listed. If this persists, see docs/office365-mail-setup.md.';
          } else {
            // Graph returns $search results by relevance and refuses $orderby
            // alongside $search, so say so — a date column otherwise reads as
            // "these are the most recent messages", which is not what this is.
            mailStatus.textContent =
              'Showing ' + data.messages.length + ' message(s) involving ' + address +
              ', ranked by relevance rather than date — the newest message may not be listed.';
          }
        } catch (error) {
          mailStatus.textContent = '';
          setError(error.message);
        }
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
          entriesBody.innerHTML = '';
          subscriptionsBody.innerHTML = '';
          invoicesBody.innerHTML = '';
          messagesBody.innerHTML = '';
          customerSummary.textContent = '';
          mailStatus.textContent = '';
          currentCustomerId = null;
          currentCustomerEmail = null;
          const q = searchInput.value.trim();
          const response = await fetch('/api/stripe/lookup?q=' + encodeURIComponent(q), {
            headers: authHeaders(),
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || 'Search failed');
          }

          currentCustomerId = data.customer.id;
          currentCustomerEmail = data.customer.email || null;
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
      loadMailButton.addEventListener('click', loadMail);

      refreshAccountsButton.addEventListener('click', loadAccounts);
      flaggedOnlyCheckbox.addEventListener('change', loadAccounts);
      accountSearchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          loadAccounts();
        }
      });
      // The flagged queue is why an operator opens this page, so it loads
      // itself — first on page load, and again as soon as a token is pasted,
      // since the page-load attempt necessarily happens without one.
      tokenNode.addEventListener('change', loadAccounts);
      loadAccounts();

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
  </body>
</html>`;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

/** A row of subscription_admin_entries, as the RETURNING clauses below select it. */
interface AdminEntryRow {
  id: number;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  entry_key: string;
  entry_value: string;
  created_at: string;
  updated_at: string;
}

/** The request body /api/entries accepts: four fields of anything, coerced below. */
export interface EntryPayloadInput {
  stripeCustomerId?: unknown;
  stripeSubscriptionId?: unknown;
  entryKey?: unknown;
  entryValue?: unknown;
}

export interface NormalizedEntryPayload {
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  entryKey: string;
  entryValue: string;
}

export type EntryValidation =
  | { ok: false; error: string }
  | { ok: true; value: NormalizedEntryPayload };

export function normalizeEntryPayload(payload: EntryPayloadInput = {}): NormalizedEntryPayload {
  return {
    stripeCustomerId: String(payload.stripeCustomerId || '').trim(),
    stripeSubscriptionId: String(payload.stripeSubscriptionId || '').trim(),
    entryKey: String(payload.entryKey || '').trim(),
    entryValue: String(payload.entryValue || '').trim(),
  };
}

export function validateEntryPayload(payload: EntryPayloadInput): EntryValidation {
  const { stripeCustomerId, stripeSubscriptionId, entryKey, entryValue } = normalizeEntryPayload(payload);

  if (!stripeCustomerId || !stripeSubscriptionId || !entryKey) {
    return { ok: false, error: 'stripeCustomerId, stripeSubscriptionId, and entryKey are required' };
  }

  if (stripeCustomerId.length > 128 || stripeSubscriptionId.length > 128 || entryKey.length > 120 || entryValue.length > 10_000) {
    return { ok: false, error: 'One or more fields exceed allowed size limits' };
  }

  return {
    ok: true,
    value: { stripeCustomerId, stripeSubscriptionId, entryKey, entryValue },
  };
}

function isAuthorized(request: Request, env: Env): boolean {
  const authHeader = request.headers.get('authorization') || '';
  const [scheme, token] = authHeader.split(' ');
  const normalizedScheme = (scheme || '').toLowerCase();
  return Boolean(
    normalizedScheme === 'token' && token && env.ADMIN_API_TOKEN && token === env.ADMIN_API_TOKEN
  );
}

/**
 * Generic because the two POST routes accept different bodies: an entry payload
 * and `{ email }`. The caller names the shape; this only decides that malformed
 * JSON is `null` rather than a thrown 500.
 */
async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return await request.json<T>();
  } catch {
    return null;
  }
}

function createEntry(db: D1Database, entry: NormalizedEntryPayload): Promise<AdminEntryRow | null> {
  return db.prepare(
    `INSERT INTO subscription_admin_entries
      (stripe_customer_id, stripe_subscription_id, entry_key, entry_value)
     VALUES (?1, ?2, ?3, ?4)
     RETURNING id, stripe_customer_id, stripe_subscription_id, entry_key, entry_value, created_at, updated_at`
  ).bind(entry.stripeCustomerId, entry.stripeSubscriptionId, entry.entryKey, entry.entryValue).first<AdminEntryRow>();
}

function updateEntry(
  db: D1Database,
  id: number,
  { entryKey, entryValue }: Pick<NormalizedEntryPayload, 'entryKey' | 'entryValue'>
): Promise<AdminEntryRow | null> {
  return db.prepare(
    `UPDATE subscription_admin_entries
     SET entry_key = ?1,
         entry_value = ?2,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?3
     RETURNING id, stripe_customer_id, stripe_subscription_id, entry_key, entry_value, created_at, updated_at`
  ).bind(entryKey, entryValue, id).first<AdminEntryRow>();
}

function deleteEntry(db: D1Database, id: number): Promise<Pick<AdminEntryRow, 'id'> | null> {
  return db
    .prepare('DELETE FROM subscription_admin_entries WHERE id = ?1 RETURNING id')
    .bind(id)
    .first<Pick<AdminEntryRow, 'id'>>();
}

function listEntries(db: D1Database, subscriptionId: string): Promise<D1Result<AdminEntryRow>> {
  if (subscriptionId) {
    return db.prepare(
      `SELECT id, stripe_customer_id, stripe_subscription_id, entry_key, entry_value, created_at, updated_at
       FROM subscription_admin_entries
       WHERE stripe_subscription_id = ?1
       ORDER BY created_at DESC`
    ).bind(subscriptionId).all<AdminEntryRow>();
  }

  return db.prepare(
    `SELECT id, stripe_customer_id, stripe_subscription_id, entry_key, entry_value, created_at, updated_at
     FROM subscription_admin_entries
     ORDER BY created_at DESC`
  ).all<AdminEntryRow>();
}

/** A row of `accounts`, exactly as ACCOUNT_COLUMNS selects it. */
export interface AccountRow {
  email: string;
  stripe_customer_id: string | null;
  flagged: number;
  flag_reason: string | null;
  flag_subject: string | null;
  last_flagged_at: string | null;
  first_seen_at: string;
}

const ACCOUNT_COLUMNS =
  'email, stripe_customer_id, flagged, flag_reason, flag_subject, last_flagged_at, first_seen_at';

/**
 * `%` and `_` are LIKE wildcards, and `_` is in every Stripe id an operator
 * might paste, so searching "cus_1" would otherwise also match "cusX1". Escape
 * them (and the escape character itself) and declare the escape in the SQL.
 */
function likePattern(value: string): string {
  return '%' + value.replace(/[\\%_]/g, (character) => '\\' + character) + '%';
}

/**
 * `flaggedOnly` is absent-means-true: the UI checkbox is checked on load and
 * the flagged queue is the reason to open the page at all. Only an explicit
 * false/0/no turns it off, so a typo shows fewer rows rather than silently
 * widening the view.
 */
export function parseFlaggedOnly(rawValue: string | null | undefined): boolean {
  if (rawValue === null || rawValue === undefined) return true;
  const normalized = String(rawValue).trim().toLowerCase();
  return !(normalized === 'false' || normalized === '0' || normalized === 'no');
}

/**
 * One statement for all four q/flaggedOnly combinations, every value bound.
 * `?1 = 0 OR flagged = 1` is how "no filter" is expressed without concatenating
 * a WHERE clause together, and `?2` is '%' when there is no search term.
 */
function listAccounts(
  db: D1Database,
  { q, flaggedOnly }: { q: string; flaggedOnly: boolean }
): Promise<D1Result<AccountRow>> {
  return db.prepare(
    `SELECT ${ACCOUNT_COLUMNS}
     FROM accounts
     WHERE (?1 = 0 OR flagged = 1)
       AND (email LIKE ?2 ESCAPE '\\' OR COALESCE(stripe_customer_id, '') LIKE ?2 ESCAPE '\\')
     ORDER BY COALESCE(last_flagged_at, first_seen_at) DESC
     LIMIT 200`
  ).bind(flaggedOnly ? 1 : 0, q ? likePattern(q) : '%').all<AccountRow>();
}

/**
 * Clears a flag without deleting the row: flag_reason and flag_subject stay as
 * history, and the account keeps appearing when "flagged only" is unchecked.
 */
function clearAccountFlag(db: D1Database, email: string): Promise<AccountRow | null> {
  return db.prepare(
    `UPDATE accounts
     SET flagged = 0
     WHERE email = ?1
     RETURNING ${ACCOUNT_COLUMNS}`
  ).bind(email).first<AccountRow>();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      return new Response('Radiatus template worker is running. Visit /admin for the admin dashboard.', { status: 200 });
    }

    if (url.pathname === '/admin' && request.method === 'GET') {
      return new Response(ADMIN_HTML, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'x-content-type-options': 'nosniff',
        },
      });
    }

    if (!url.pathname.startsWith('/api/')) {
      return json({ error: 'Not found' }, 404);
    }

    if (!isAuthorized(request, env)) {
      return json({ error: 'Unauthorized. Send Authorization: Token <token>' }, 401);
    }

    if (url.pathname === '/api/stripe/lookup' && request.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) {
        return json({ error: 'q is required' }, 400);
      }
      if (!isStripeConfigured(env)) {
        return json({ error: 'STRIPE_SECRET_KEY is not configured' }, 500);
      }
      try {
        const result = await lookupStripeRecord(env, q);
        if (!result.found) {
          return json({ error: 'No Stripe customer or subscription matches that search' }, 404);
        }
        return json(result);
      } catch (error) {
        if (error instanceof StripeApiError) {
          return json({ error: 'Stripe API error', stripeStatus: error.status }, 502);
        }
        throw error;
      }
    }

    if (url.pathname === '/api/mail/lookup' && request.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) {
        return json({ error: 'q is required' }, 400);
      }
      // Bounded like the /api/entries handler. Without this an oversized q
      // reaches Graph, comes back 400, and the panel reports it as a mailbox
      // capability finding — the operator then debugs the wrong thing.
      if (q.length > 320) {
        return json({ error: 'q is too long' }, 400);
      }
      // Optional feature: an unconfigured template says so rather than 500ing.
      if (!isGraphConfigured(env)) {
        return json({ error: 'Office 365 mail lookup is not configured' }, 501);
      }
      try {
        // env only — q is the address to look for, never the mailbox to read.
        const result = await listCorrespondence(env, q);
        return json(result, 200, { 'cache-control': 'no-store' });
      } catch (error) {
        if (error instanceof GraphApiError) {
          // Graph's own message can quote back tenant/app configuration, so the
          // status is all the client gets — same rule as the Stripe route.
          return json({ error: 'Microsoft Graph error', graphStatus: error.status }, 502);
        }
        throw error;
      }
    }

    if (url.pathname === '/api/accounts' && request.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      // Same bound as the mail route: an address is at most 320 characters, and
      // an unbounded LIKE pattern is a pointless full scan.
      if (q.length > 320) {
        return json({ error: 'q is too long' }, 400);
      }
      const flaggedOnly = parseFlaggedOnly(url.searchParams.get('flaggedOnly'));
      const result = await listAccounts(env.DB, { q, flaggedOnly });
      // no-store for the same reason /api/mail/lookup sets it: flag_subject is
      // a support-mail subject line copied verbatim, which is message content.
      return json({ accounts: result.results || [], flaggedOnly }, 200, { 'cache-control': 'no-store' });
    }

    if (url.pathname === '/api/accounts/resolve' && request.method === 'POST') {
      const payload = await readJson<{ email?: unknown }>(request);
      // Lowercased on the way in, like every other write path: accounts are
      // keyed by email and SQLite compares text case-sensitively.
      const email = String(payload?.email || '').trim().toLowerCase();
      if (!email) {
        return json({ error: 'email is required' }, 400);
      }
      if (email.length > 320) {
        return json({ error: 'email is too long' }, 400);
      }
      const account = await clearAccountFlag(env.DB, email);
      if (!account) {
        return json({ error: 'Account not found' }, 404);
      }
      return json({ account });
    }

    if (url.pathname === '/api/entries' && request.method === 'GET') {
      const subscriptionId = (url.searchParams.get('subscriptionId') || '').trim();
      if (subscriptionId.length > 128) {
        return json({ error: 'subscriptionId is too long' }, 400);
      }
      const result = await listEntries(env.DB, subscriptionId);
      return json({ entries: result.results || [] });
    }

    if (url.pathname === '/api/entries' && request.method === 'POST') {
      const payload = await readJson<EntryPayloadInput>(request);
      const validation = validateEntryPayload(payload || {});
      if (!validation.ok) {
        return json({ error: validation.error }, 400);
      }

      const entry = await createEntry(env.DB, validation.value);
      return json({ entry }, 201);
    }

    const idMatch = url.pathname.match(/^\/api\/entries\/(\d+)$/);
    if (idMatch && request.method === 'PUT') {
      const payload = await readJson<EntryPayloadInput>(request);
      const normalized = normalizeEntryPayload(payload || {});
      if (!normalized.entryKey || normalized.entryKey.length > 120 || normalized.entryValue.length > 10_000) {
        return json({ error: 'entryKey is required and fields must meet size limits' }, 400);
      }

      const updated = await updateEntry(env.DB, Number(idMatch[1]), {
        entryKey: normalized.entryKey,
        entryValue: normalized.entryValue,
      });

      if (!updated) {
        return json({ error: 'Entry not found' }, 404);
      }

      return json({ entry: updated });
    }

    if (idMatch && request.method === 'DELETE') {
      const deleted = await deleteEntry(env.DB, Number(idMatch[1]));
      if (!deleted) {
        return json({ error: 'Entry not found' }, 404);
      }
      return json({ deletedId: deleted.id });
    }

    return json({ error: 'Method not allowed' }, 405);
  },

  /**
   * Cron entry point for auto-flagging (see [triggers] in wrangler.toml).
   *
   * Most adopters never configure Graph, and their Worker must not throw on a
   * schedule because of a feature they did not enable — so an unconfigured
   * deployment returns immediately and silently. There is nothing to report:
   * "not set up" is the expected state, not a fault.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!isGraphConfigured(env)) return;
    const run = pollAndFlag(env);
    // Awaiting is what makes a failure surface as a failed cron invocation
    // rather than a dropped promise; waitUntil registers the same work with the
    // runtime so completion never depends on how the return value is treated.
    ctx.waitUntil(run);
    // The one line docs/office365-mail-setup.md's "check the Worker's cron
    // invocation log" instruction depends on. Without it a successful run
    // writes nothing at all, so a poller stalled on a watermark and a genuinely
    // quiet mailbox are indistinguishable from the outside.
    console.log('auto-flagging poll: ' + JSON.stringify(await run));
  },
} satisfies ExportedHandler<Env>;
