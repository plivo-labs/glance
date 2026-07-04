import { MousePointerSquareDashed } from 'lucide-react'

// The visual label for an element ("pinpoint") anchor: a small tag chip + the captured preview.
// Shared by the composing preview (ReviewRail) and the thread header (ThreadCard) so both read the
// same. Falls back to sensible labels when tag/preview are empty.
export function AnchorChip({ tag, preview }: { tag: string; preview: string }) {
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
      <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
        <MousePointerSquareDashed className="size-3" />
        {tag || 'element'}
      </span>
      <span className="line-clamp-1 italic">{preview || 'Element'}</span>
    </span>
  )
}
