import { CircleHelp } from 'lucide-react'
import { GettingStarted } from '@/components/GettingStarted'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'

// Header "?" next to the What's New sparkle: the same GettingStarted walkthrough the empty
// dashboard shows, permanently reachable — e.g. grabbing the install one-liner on a new machine.
export function HelpButton() {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="How to use Glance" title="How to use Glance">
          <CircleHelp className="size-4" />
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="flex items-center gap-2">
            <CircleHelp className="size-4 text-primary" />
            Using Glance
          </SheetTitle>
          <SheetDescription className="sr-only">How to install the CLI and publish your first site.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <GettingStarted />
        </div>
      </SheetContent>
    </Sheet>
  )
}
