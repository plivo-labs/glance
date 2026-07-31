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

// [method, path, what it does, whether a key credential may call it]
function EndpointTable({ rows }: { rows: [string, string, string, string][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <tbody>
          {rows.map(([method, path, purpose, keyAllowed]) => (
            <tr key={`${method} ${path}`} className="border-b last:border-0">
              <td className="py-1.5 pr-3 align-top font-mono text-foreground">{method}</td>
              <td className="py-1.5 pr-3 align-top font-mono">{path}</td>
              <td className="py-1.5 pr-3 align-top">{purpose}</td>
              <td className="py-1.5 align-top whitespace-nowrap">{keyAllowed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
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
  // The reader's own instance, so every command below is copy-pasteable as-is rather than a
  // placeholder they have to substitute. Same treatment as the install command in GettingStarted:
  // the SPA is served FROM the app origin, so this is always the right host — and the source stays
  // vendor-neutral for a self-hosted deploy.
  const origin = window.location.origin

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
            , click <strong className="text-foreground">New key</strong>. Give it a name, an expiry (1, 7, 30, 90, 180,
            or 365 days — the only durations Glance will ever mint), and site access: either a set of sites you pick, or
            every site you own. There's also an optional checkbox to let the key manage sites (deploy, create, fork) —
            off by default.
          </p>
          <p>
            The secret is shown <strong className="text-foreground">exactly once</strong>, right after creation. Glance
            stores only its hash — if you lose it, revoke it and mint a new one.
          </p>
        </Section>

        <Section title="Run it on a server">
          <p>
            This is what keys are for: a cron job, a CI step, or any script that runs where nobody can sit and complete
            a login prompt. Export the key as <Code>GLANCE_TOKEN</Code> and the CLI skips <Code>glance login</Code>{' '}
            entirely:
          </p>
          <CodeBlock>
            {`curl -fsSL ${origin}/api/install | sh\nexport GLANCE_TOKEN=glk_...\nglance deploy ./my-site`}
          </CodeBlock>
          <p>
            The CLI reads its target instance from <Code>~/.glance/config.json</Code>, not from the key, so the install
            step above matters on a fresh box. <Code>GLANCE_TOKEN</Code> is only honoured by commands that call the API
            — <Code>glance logout</Code> ignores it deliberately, so it always acts on your real session, not a key you
            happen to have exported.
          </p>
        </Section>

        <Section title="What a key can do">
          <p>
            With the "manage sites" grant, a key can deploy and create sites the same as you can. Without it, the key
            can still read and use the data plane, but any request that would change a site — deploy, create, fork,
            move, rename, share — is refused. It can never delete a site, and it can never mint or revoke another key:
            both are denied outright, whatever its grants.
          </p>
          <p>
            <strong className="text-foreground">One gap to scope around:</strong> deleting a <em>space</em> is not
            covered by that rule. A key with the "manage sites" grant can delete a group space it created, which
            destroys every site inside it. Personal spaces are protected, and the delete is refused if the space holds
            sites owned by other members — but your own sites in your own group space can be erased this way despite the
            per-site rule above.
          </p>
        </Section>

        <Section title="Call the API directly">
          <p>
            The CLI is a convenience — a key is a bearer token against the same HTTP API. Send it as an{' '}
            <Code>Authorization</Code> header:
          </p>
          <CodeBlock>{`curl -H "Authorization: Bearer $GLANCE_TOKEN" \\\n  ${origin}/api/sites/mine`}</CodeBlock>
          <p>Deploying is a multipart upload, one form field per file:</p>
          <CodeBlock>
            {`curl -X POST "${origin}/api/upload/<space>/<site>" \\
  -H "Authorization: Bearer $GLANCE_TOKEN" \\
  -F "files=@dist/index.html;filename=index.html" \\
  -F "visibility=team"`}
          </CodeBlock>
          <p>
            Key management itself lives at <Code>/api/api-keys</Code> — a key may list your keys, but minting and
            revoking are refused to it and stay yours alone. Full endpoint reference — sites, spaces, shares, forks,
            response shapes and status codes — is in <Code>packages/api/API.md</Code>.
          </p>
        </Section>

        <Section title="Read and write a page's data">
          <p>
            Every site has a document store (<Code>glance.db</Code>) — the same one a live dashboard or a form on the
            page reads from. A script can fill it, which is how a page updates itself between deploys: the cron job
            writes the new numbers, the open page re-renders.
          </p>
          <p>
            The key doesn't work on the data plane directly. Exchange it for a{' '}
            <strong className="text-foreground">data token</strong>, then use that:
          </p>
          <CodeBlock>
            {`TOKEN=$(curl -fsS -X POST \\
  -H "Authorization: Bearer $GLANCE_TOKEN" \\
  "${origin}/api/data-token/<space>/<site>" | jq -r .token)`}
          </CodeBlock>
          <p>
            That token lasts <strong className="text-foreground">300 seconds</strong> — mint one per run, never bake it
            into a config file. A <Code>401</Code> on the data plane means it aged out.
          </p>
          <p>
            With it, documents are plain JSON over <Code>/api/_data</Code>. The last column is the capability the token
            must carry:
          </p>
          <EndpointTable
            rows={[
              ['GET', '/api/_data/:collection', 'list, newest first — ?limit= (default 50, max 200)', 'read'],
              ['GET', '/api/_data/:collection/:docId', 'fetch one document', 'read'],
              ['POST', '/api/_data/:collection', 'create — the id is assigned for you', 'create'],
              ['PUT', '/api/_data/:collection/:docId', 'create or replace at an id you choose', 'write'],
              ['DELETE', '/api/_data/:collection/:docId', 'delete — 204, idempotent', 'write'],
            ]}
          />
          <p>
            Reads come back as <Code>{'{ id, data, createdBy, createdAt, updatedAt }'}</Code>, and a list wraps them in{' '}
            <Code>{'{ items: [...] }'}</Code>. Your JSON is whatever you put in <Code>data</Code>.
          </p>
          <p>
            So the cron job that refreshes a dashboard is one <Code>PUT</Code> at a stable id — the page reads the same
            row every time, no accumulating history:
          </p>
          <CodeBlock>
            {`curl -fsS -X PUT \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"signups": 412, "mrr": 91400}' \\
  "${origin}/api/_data/shared-metrics/today"`}
          </CodeBlock>
          <p>
            <strong className="text-foreground">Two rules worth knowing.</strong> Reads are scoped to your own rows by
            default; name a collection <Code>shared-*</Code> and every viewer of the site can read it — that's what
            makes the numbers above visible on the page. And any viewer may read and create, but <Code>PUT</Code>/
            <Code>DELETE</Code> are the site owner's alone, so a visitor can submit to your form and never edit what's
            there. Documents cap at 100KB each, 5,000 per site.
          </p>
          <p>
            A key reaches only the sites its grant allows, and its capability ceiling (read, create, write, read_all)
            narrows the minted token further. It can restrict what you could otherwise do, never widen it — a key with
            no data grant is <Code>403</Code> at the mint.
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
            One exception: a data token the key already minted before revocation keeps working for the rest of its own
            lifetime — up to 5 minutes (300 seconds). That token is a self-contained, signed credential, not a lookup
            against the key, so revoking the key doesn't reach back into tokens it already handed out.
          </p>
        </Section>
      </div>
    </div>
  )
}
