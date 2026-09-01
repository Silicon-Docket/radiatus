# AGENTS.md

Instructions for an AI coding agent helping someone deploy this template to their own Cloudflare account. If you're a human, the [README](./README.md#quick-start) covers the same steps.

## Ground rules

- **Never invent a secret value.** `ADMIN_API_TOKEN` is generated once and only the human should choose or approve it. You may offer to generate a random one (e.g. `openssl rand -hex 32`), but show it to them and let them say yes before using it.
- **Confirm before anything that costs money, creates a cloud resource, or publishes.** Creating a D1 database, setting a secret, and running `wrangler deploy` all act on the human's real Cloudflare account. Say what you're about to run and why, then run it — don't batch these behind a single silent approval.
- **Never commit a secret.** `.dev.vars` is gitignored; keep it that way. `wrangler secret put` uploads directly to Cloudflare and never touches a file in this repo.
- **Don't attempt interactive browser login on the human's behalf.** If `npx wrangler whoami` shows no logged-in account, ask the human to run `npx wrangler login` themselves and tell you when it's done.

## Deploy sequence

1. Check whether Wrangler is authenticated:

   ```bash
   npx wrangler whoami
   ```

   If it isn't, stop and ask the human to run `npx wrangler login`.

2. Install dependencies:

   ```bash
   npm install --save-dev wrangler
   ```

3. Create the D1 database and capture its id:

   ```bash
   npx wrangler d1 create radiatus
   ```

   Parse `database_id` from the output and write it into `wrangler.toml` in place of `replace-with-your-d1-database-id`.

4. Get a value for `ADMIN_API_TOKEN`, and a Stripe secret key for `STRIPE_SECRET_KEY` (ask the human for one — a restricted, read-only test-mode key is enough to verify the deploy works), then set both in the two places they're each needed — local `.dev.vars` and the deployed Worker's secrets are independent and `wrangler` does not sync them:

   ```bash
   cp .dev.vars.example .dev.vars
   # write ADMIN_API_TOKEN=<value> and STRIPE_SECRET_KEY=<value> into .dev.vars

   npx wrangler secret put ADMIN_API_TOKEN
   # paste the ADMIN_API_TOKEN value when prompted — uploads it to the deployed Worker
   npx wrangler secret put STRIPE_SECRET_KEY
   # paste the STRIPE_SECRET_KEY value when prompted
   ```

5. Apply the schema to the new database:

   ```bash
   npm run db:migrate:remote
   ```

6. Confirm with the human, then deploy:

   ```bash
   npm run deploy
   ```

7. Wrangler prints a `*.workers.dev` URL. Verify the deployment by requesting it, and check that `/admin` loads. Report the URL back to the human, and remind them to store the `ADMIN_API_TOKEN` value somewhere durable (a password manager) — it isn't recoverable from Cloudflare after the fact.

## If the human already clicked "Deploy to Cloudflare"

The one-click button in the README provisions the D1 database and Worker automatically from `wrangler.toml`, and reads `.dev.vars.example` to prompt for `ADMIN_API_TOKEN` and `STRIPE_SECRET_KEY` during setup. It does not run this template's migration. After it finishes, run step 5 and 7 above against the repository it created for them.
