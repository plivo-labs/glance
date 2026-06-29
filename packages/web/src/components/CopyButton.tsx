import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

// Copy-to-clipboard with a transient Check flash + a toast. The setTimeout lives in the
// click handler (not an effect) — allowed under the no-useEffect rule.
export function CopyButton({
  text,
  label = 'Copy link',
  title,
  className,
  variant = 'outline',
  size = 'sm',
}: {
  text: string
  label?: string
  // Hover/accessible name when rendered icon-only (label=''); falls back to the label otherwise.
  title?: string
  className?: string
  variant?: React.ComponentProps<typeof Button>['variant']
  size?: React.ComponentProps<typeof Button>['size']
}) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      title={title ?? label}
      aria-label={title ?? label}
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          toast.success('Link copied', { description: text })
          setTimeout(() => setCopied(false), 1500)
        } catch {
          toast.error("Couldn't copy to clipboard")
        }
      }}
    >
      {copied ? <Check /> : <Copy />}
      {label}
    </Button>
  )
}
