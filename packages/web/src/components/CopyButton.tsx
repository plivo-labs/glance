import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

// Copy-to-clipboard with a transient Check flash + a toast. The setTimeout lives in the
// click handler (not an effect) — allowed under the no-useEffect rule.
export function CopyButton({
  text,
  label = 'Copy link',
  copiedMessage = 'Link copied',
  className,
  variant = 'outline',
  size = 'sm',
}: {
  text: string
  label?: string
  copiedMessage?: string
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
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          toast.success(copiedMessage, { description: text })
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
