import { defineConfig } from 'drizzle-kit'

// `out` MUST equal `migrations_dir` in wrangler.jsonc so drizzle-kit generate and
// `wrangler d1 migrations apply` share one folder. dialect 'sqlite' (D1 = SQLite).
// Flow is codegen-only: `drizzle-kit generate` → `wrangler d1 migrations apply`.
// drizzle-kit never touches the DB, so no d1-http credentials are needed.
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
})
