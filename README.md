# radiatus

A Cloudflare Worker + D1 template for building an admin dashboard that manages database entries linked to Stripe subscriptions.

## What this template includes

- Worker API with token-protected CRUD endpoints for subscription-scoped records.
- Built-in `/admin` page to create, list, update, and delete entries.
- D1 schema for `subscription_admin_entries` keyed by:
  - `stripe_customer_id`
  - `stripe_subscription_id`
  - `entry_key`
  - `entry_value`

## Quick start

1. Install dependencies:

   ```bash
   npm install --save-dev wrangler
   ```

2. Create a D1 database (if you don't already have one):

   ```bash
   npx wrangler d1 create radiatus
   ```

3. Replace `database_id` in `/home/runner/work/radiatus/radiatus/wrangler.toml` with the value from step 2.

4. Add an admin token secret:

   ```bash
   npx wrangler secret put ADMIN_API_TOKEN
   ```

5. Run the migration:

   ```bash
   npm run db:migrate:local
   ```

6. Start dev server:

   ```bash
   npm run dev
   ```

7. Open the admin UI:

   ```
   http://127.0.0.1:8787/admin
   ```

## API summary

All `/api/*` routes require:

```
Authorization: Token <token>
```

- `GET /api/entries?subscriptionId=sub_123` - list entries, optionally filtered by Stripe subscription ID.
- `POST /api/entries` - create a new entry.
- `PUT /api/entries/:id` - update an entry key/value.
- `DELETE /api/entries/:id` - delete an entry.

## Local validation

```bash
npm run lint
npm test
```
