# Contributing to Glance

## Setup

```sh
bun install
cp packages/api/.dev.vars.example packages/api/.dev.vars
# edit .dev.vars with your GitHub OAuth app credentials
bun run db:migrate:local
bun run dev
```

The dev server starts three processes:
- API worker on `http://localhost:8787`
- Content worker on `http://localhost:8788`
- Vite dev server on `http://localhost:5173`

## Type generation

`worker-configuration.d.ts` is gitignored and must be generated before typechecking:

```sh
bun run cf-typegen
```

## Checks

```sh
bun run typecheck   # tsc --noEmit across all packages
bun test            # bun test across all packages
bun run lint        # biome check
bun run format      # biome format --write
```

## Branch & PR conventions

- Branch off `main`: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`
- Keep PRs focused — one logical change per PR
- All checks must pass before merge
- Squash merge preferred; keep a clean linear history

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(api): add presigned upload endpoint
fix(auth): clear session cookie on logout
chore: bump wrangler to 4.x
```

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`

Breaking changes: append `!` after the type/scope and add a `BREAKING CHANGE:` footer.
