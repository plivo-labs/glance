import { KeyRound } from 'lucide-react'
import { Link } from 'react-router'

// Static reference for the API keys feature (S12). Reserved slug ('docs', see
// RESERVED_SLUGS) — registered BEFORE the `:space` catch-all in router.tsx, same ordering
// hazard as 'whats-new' and 'settings/keys'. No loader: nothing here is fetched, so the page
// renders the same for a logged-in or logged-out visitor.

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs">
      <code>{children}</code>
    </pre>
  )
}

function Code({ children }: { children: string }) {
  return <code className="rounded bg-muted px-1 py-0.5 text-xs">{children}</code>
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="font-semibold text-lg leading-snug">{title}</h2>
      <div className="space-y-2 text-muted-foreground text-sm leading-relaxed">{children}</div>
    </section>
  )
}

export function Component() {
  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-8 flex items-center gap-2">
        <KeyRound className="size-5 text-primary" />
        <h1 className="font-semibold text-2xl tracking-tight">API Keys</h1>
      </div>

      <div className="space-y-8">
        <Section title="Create a key">
          <p>
            From{' '}
            <Link to="/settings/keys" className="font-medium text-primary hover:underline">
              /settings/keys
            </Link>
            , click <strong className="text-foreground">New key</strong>. Give it a name, an expiry (1, 7, 30, 90,
            180, or 365 days — the only durations Glance will ever mint), and site access: either a set of sites you
            pick, or every site you own. There's also an optional checkbox to let the key manage sites (deploy,
            create, fork) — off by default.
          </p>
          <p>
            The secret is shown <strong className="text-foreground">exactly once</strong>, right after creation.
            Glance stores only its hash — if you lose it, revoke it and mint a new one.
          </p>
        </Section>

        <Section title="Use it with the CLI">
          <p>
            The CLI reads its target instance from <Code>~/.glance/config.json</Code>, not from the key — so install
            and point it at this instance first:
          </p>
          <CodeBlock>{'curl -fsSL <this instance origin>/api/install | sh'}</CodeBlock>
          <p>
            Then export the key as <Code>GLANCE_TOKEN</Code> instead of running <Code>glance login</Code>:
          </p>
          <CodeBlock>{'export GLANCE_TOKEN=glk_...\nglance deploy ./my-site'}</CodeBlock>
          <p>
            <Code>GLANCE_TOKEN</Code> is only checked by commands that call the API — <Code>glance logout</Code>{' '}
            ignores it deliberately, so it always acts on your real session, not a key you happen to have exported.
          </p>
        </Section>

        <Section title="What a key can do">
          <p>
            With the "manage sites" grant, a key can deploy and create sites the same as you can. Without it, the
            key can still read and use the data plane, but any request that would change a site — deploy, create,
            fork, move, rename, share — is refused. It can never delete a site, and it can never mint or revoke
            another key: both are denied outright, whatever its grants.
          </p>
        </Section>

        <Section title="Data access">
          <p>
            A key's data grant is an allowlist — the specific sites you selected, or "all owned sites" — plus a
            capability ceiling (read, create, write, read_all) on top of it. When the key is used to mint a
            glance.db data token, that ceiling only ever narrows what the token can carry: it can restrict what
            you could otherwise do, never grant more than your own access already allows.
          </p>
        </Section>

        <Section title="Expiry &amp; revocation">
          <p>
            A key stops authenticating the moment it expires or is revoked from{' '}
            <Link to="/settings/keys" className="font-medium text-primary hover:underline">
              /settings/keys
            </Link>
            . Revoked keys stay listed, greyed out, rather than disappearing.
          </p>
          <p>
            One exception: a data token the key already minted before revocation keeps working for the rest of its
            own lifetime — up to 5 minutes (300 seconds). That token is a self-contained, signed credential, not a
            lookup against the key, so revoking the key doesn't reach back into tokens it already handed out.
          </p>
        </Section>
      </div>
    </div>
  )
}
