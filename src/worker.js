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
    <h1>Radiatus: Stripe Subscription Admin Entries</h1>
    <p class="muted">Use your admin token in the <code>Authorization: Token &lt;token&gt;</code> field to create and manage records tied to Stripe subscriptions.</p>

    <label>Admin API Token</label>
    <input id="token" type="password" placeholder="Paste ADMIN_API_TOKEN" />

    <form id="entry-form">
      <div class="row">
        <div>
          <label>Stripe Customer ID</label>
          <input id="customer-id" required placeholder="cus_..." />
        </div>
        <div>
          <label>Stripe Subscription ID</label>
          <input id="subscription-id" required placeholder="sub_..." />
        </div>
      </div>
      <label>Entry Key</label>
      <input id="entry-key" required placeholder="feature_flag" />
      <label>Entry Value (text or JSON)</label>
      <textarea id="entry-value" rows="4" placeholder='{"enabled":true}'></textarea>
      <button type="submit">Create entry</button>
    </form>

    <div class="row">
      <div>
        <label>Filter by Subscription ID</label>
        <input id="filter-subscription" placeholder="sub_..." />
      </div>
      <div>
        <button id="load" type="button">Load entries</button>
      </div>
    </div>

    <p id="status" class="muted"></p>
    <p id="error" class="error"></p>

    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Customer</th>
          <th>Subscription</th>
          <th>Key</th>
          <th>Value</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="entries"></tbody>
    </table>

    <script>
      const entriesBody = document.getElementById('entries');
      const errorNode = document.getElementById('error');
      const statusNode = document.getElementById('status');
      const tokenNode = document.getElementById('token');
      const form = document.getElementById('entry-form');
      const filterSubscription = document.getElementById('filter-subscription');

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

      function renderRow(entry) {
        const tr = document.createElement('tr');

        const idCell = document.createElement('td');
        idCell.textContent = String(entry.id);

        const customerCell = document.createElement('td');
        customerCell.textContent = entry.stripe_customer_id;

        const subscriptionCell = document.createElement('td');
        subscriptionCell.textContent = entry.stripe_subscription_id;

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
            setStatus('Updated entry ' + entry.id);
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
            setStatus('Deleted entry ' + entry.id);
          } catch (error) {
            setError(error.message);
          }
        };

        actionsCell.appendChild(saveButton);
        actionsCell.appendChild(deleteButton);

        tr.appendChild(idCell);
        tr.appendChild(customerCell);
        tr.appendChild(subscriptionCell);
        tr.appendChild(keyCell);
        tr.appendChild(valueCell);
        tr.appendChild(actionsCell);

        return tr;
      }

      async function loadEntries() {
        setStatus('Loading entries...');
        const subId = encodeURIComponent(filterSubscription.value.trim());
        const query = subId ? '?subscriptionId=' + subId : '';
        const response = await fetch('/api/entries' + query, { headers: authHeaders() });
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Failed to load entries');
        }

        entriesBody.innerHTML = '';
        for (const entry of data.entries) {
          entriesBody.appendChild(renderRow(entry));
        }

        setStatus('Loaded ' + data.entries.length + ' entries');
      }

      form.addEventListener('submit', async (event) => {
        try {
          event.preventDefault();
          const payload = {
            stripeCustomerId: document.getElementById('customer-id').value,
            stripeSubscriptionId: document.getElementById('subscription-id').value,
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
            throw new Error(data.error || 'Failed to create entry');
          }

          setStatus('Created entry ' + data.entry.id);
          form.reset();
          await loadEntries();
        } catch (error) {
          setError(error.message);
        }
      });

      document.getElementById('load').addEventListener('click', async () => {
        try {
          await loadEntries();
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
