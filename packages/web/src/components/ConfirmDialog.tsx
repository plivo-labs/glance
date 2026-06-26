import { useState } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'

// Replacement for window.confirm(). `children` is the trigger; `onConfirm` may be async —
// while it runs we show a spinner; on success we close, on failure we toast and stay open.
export function ConfirmDialog({
  children,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive = false,
  onConfirm,
}: {
  children: React.ReactNode
  title: string
  description?: string
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  return (
    <AlertDialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm()
                setOpen(false)
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Something went wrong')
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy && <Loader2 className="animate-spin" />}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
