// `generate` is pure: it diffs schema.ts against migrations/ and writes SQL, touching no
// database. Applying the result is wrangler's job (see the db:migrate:* scripts), so this
// config has no driver/dbCredentials block.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './db/schema.ts',
  out: './migrations',
  strict: true,
  verbose: true,
});
