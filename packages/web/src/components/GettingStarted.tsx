import { MessageSquareText, Terminal } from 'lucide-react'
import { CopyButton } from '@/components/CopyButton'

// The onboarding walkthrough, rendered in TWO surfaces: the dashboard's empty sites tab and the
// header HelpButton sheet. Prompt-first on purpose — the product pitch is "your AI writes the
// HTML"; the CLI is plumbing. Every command and prompt is copyable.

// One copyable line: mono text + an icon-only CopyButton. Used for shell commands and AI prompts
// alike so the "grab this" affordance is identical everywhere.
function CopyRow({ text, copiedMessage }: { text: string; copiedMessage: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/40 py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={text}>
        {text}
      </code>
      <CopyButton text={text} label="" copiedMessage={copiedMessage} variant="ghost" size="icon" className="shrink-0" />
    </div>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 font-mono font-semibold text-primary text-xs">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-medium text-sm leading-6">{title}</p>
        {children}
      </div>
    </li>
  )
}

const PROMPTS = [
  'Explain this codebase with an HTML dashboard and publish it to glance',
  'Turn these notes into a polished HTML page and deploy it to glance',
]

export function GettingStarted() {
  const installCommand = `curl -fsSL ${window.location.origin}/api/install | sh`
  return (
    <div className="space-y-5">
      <p className="text-muted-foreground text-sm">
        Glance hosts self-contained HTML your AI builds — ship a page from the terminal, share the link, collect
        comments.
      </p>
      <ol className="space-y-5">
        <Step n={1} title="Install the CLI">
          <CopyRow text={installCommand} copiedMessage="Install command copied" />
          <p className="text-muted-foreground text-xs">
            <Terminal className="mr-1 inline size-3 align-[-1px]" />
            Also installs the glance skill, so Claude Code knows how to deploy here.
          </p>
        </Step>
        <Step n={2} title="Sign in">
          <CopyRow text="glance login" copiedMessage="Command copied" />
        </Step>
        <Step n={3} title="Ask your AI">
          <div className="space-y-2">
            {PROMPTS.map((prompt) => (
              <CopyRow key={prompt} text={prompt} copiedMessage="Prompt copied" />
            ))}
          </div>
          <p className="text-muted-foreground text-xs">
            <MessageSquareText className="mr-1 inline size-3 align-[-1px]" />
            Claude builds the HTML and runs <code className="font-mono">glance deploy</code> for you — or run it
            yourself on any folder.
          </p>
        </Step>
      </ol>
      <p className="border-t pt-4 text-muted-foreground text-xs">
        No CLI? Drop a folder or a lone HTML file on the dashboard to ship it straight from the browser.
      </p>
    </div>
  )
}
