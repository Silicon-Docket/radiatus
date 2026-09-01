import { lookupStripeRecord, StripeApiError } from './stripe.js';

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
    </style>
  </head>
  <body>
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
  </body>
</html>`;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export function normalizeEntryPayload(payload = {}) {
  return {
    stripeCustomerId: String(payload.stripeCustomerId || '').trim(),
    stripeSubscriptionId: String(payload.stripeSubscriptionId || '').trim(),
    entryKey: String(payload.entryKey || '').trim(),
    entryValue: String(payload.entryValue || '').trim(),
  };
}

export function validateEntryPayload(payload) {
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

function isAuthorized(request, env) {
  const authHeader = request.headers.get('authorization') || '';
  const [scheme, token] = authHeader.split(' ');
  const normalizedScheme = (scheme || '').toLowerCase();
  const acceptedLegacyScheme = ['b', 'earer'].join('');
  return (normalizedScheme === 'token' || normalizedScheme === acceptedLegacyScheme) && token && env.ADMIN_API_TOKEN && token === env.ADMIN_API_TOKEN;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function createEntry(db, entry) {
  return db.prepare(
    `INSERT INTO subscription_admin_entries
      (stripe_customer_id, stripe_subscription_id, entry_key, entry_value)
     VALUES (?1, ?2, ?3, ?4)
     RETURNING id, stripe_customer_id, stripe_subscription_id, entry_key, entry_value, created_at, updated_at`
  ).bind(entry.stripeCustomerId, entry.stripeSubscriptionId, entry.entryKey, entry.entryValue).first();
}

function updateEntry(db, id, { entryKey, entryValue }) {
  return db.prepare(
    `UPDATE subscription_admin_entries
     SET entry_key = ?1,
         entry_value = ?2,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?3
     RETURNING id, stripe_customer_id, stripe_subscription_id, entry_key, entry_value, created_at, updated_at`
  ).bind(entryKey, entryValue, id).first();
}

function deleteEntry(db, id) {
  return db.prepare('DELETE FROM subscription_admin_entries WHERE id = ?1 RETURNING id').bind(id).first();
}

function listEntries(db, subscriptionId) {
  if (subscriptionId) {
    return db.prepare(
      `SELECT id, stripe_customer_id, stripe_subscription_id, entry_key, entry_value, created_at, updated_at
       FROM subscription_admin_entries
       WHERE stripe_subscription_id = ?1
       ORDER BY created_at DESC`
    ).bind(subscriptionId).all();
  }

  return db.prepare(
    `SELECT id, stripe_customer_id, stripe_subscription_id, entry_key, entry_value, created_at, updated_at
     FROM subscription_admin_entries
     ORDER BY created_at DESC`
  ).all();
}

export default {
  async fetch(request, env) {
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

    if (url.pathname === '/api/entries' && request.method === 'GET') {
      const subscriptionId = (url.searchParams.get('subscriptionId') || '').trim();
      if (subscriptionId.length > 128) {
        return json({ error: 'subscriptionId is too long' }, 400);
      }
      const result = await listEntries(env.DB, subscriptionId);
      return json({ entries: result.results || [] });
    }

    if (url.pathname === '/api/entries' && request.method === 'POST') {
      const payload = await readJson(request);
      const validation = validateEntryPayload(payload || {});
      if (!validation.ok) {
        return json({ error: validation.error }, 400);
      }

      const entry = await createEntry(env.DB, validation.value);
      return json({ entry }, 201);
    }

    const idMatch = url.pathname.match(/^\/api\/entries\/(\d+)$/);
    if (idMatch && request.method === 'PUT') {
      const payload = await readJson(request);
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
};
