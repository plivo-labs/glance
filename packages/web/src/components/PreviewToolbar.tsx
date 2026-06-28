import { useRef, useState } from 'react'
import { ChevronDown, Home, MessageSquare } from 'lucide-react'
import { Link } from 'react-router'
import type { ViewerSite } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/CopyButton'
import { ShareDialog } from '@/components/ShareDialog'
import { VISIBILITY_META } from '@/components/visibility'

// Liquid-glass floating menu over the full-bleed preview. Collapsed it's a translucent pill
// (visibility icon + title); click expands it into a tight row of actions — Home (back to the
// dashboard, the only way out of this standalone tab), Copy link, and Share (owners). Idle-fades
// to stay out of the way — timer is event-driven (ref callback arms it, hover wakes it) per the
// no-useEffect rule.
// The glass look layers three things: (1) an SVG feTurbulence→feDisplacementMap refraction applied
// to the backdrop (Chromium-only; degrades to plain blur elsewhere), (2) blur+saturate+brightness
// to lift the backdrop, (3) inset specular highlights + a top sheen for the curved-glass edge.
export function PreviewToolbar({ site, onReview }: { site: ViewerSite; onReview?: () => void }) {
  const [open, setOpen] = useState(false)
  const [dimmed, setDimmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const armed = useRef(false)

  function clear() {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  function arm() {
    clear()
    timer.current = setTimeout(() => setDimmed(true), 2800)
  }
  function wake() {
    clear()
    setDimmed(false)
  }

  const Icon = VISIBILITY_META[site.visibility].icon
  const title = site.title ?? site.siteSlug

  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center px-4">
      {/* Refraction filter: organic turbulence warps the backdrop near the pill like real curved
          glass (the signature liquid-glass cue, beyond a flat blur). Referenced by backdrop-filter
          below. SVG-as-backdrop-filter is Chromium-only; elsewhere the url() no-ops and the blur
          fallback still reads as glass. Rendered once; scales to any pill width (no bespoke map). */}
      <svg aria-hidden="true" role="presentation" className="absolute size-0">
        <filter
          id="liquid-glass"
          x="-30%"
          y="-30%"
          width="160%"
          height="160%"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence type="fractalNoise" baseFrequency="0.013 0.017" numOctaves="2" seed="11" result="noise" />
          <feGaussianBlur in="noise" stdDeviation="2.4" result="smooth" />
          <feDisplacementMap in="SourceGraphic" in2="smooth" scale="12" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </svg>
      <div
        ref={(n) => {
          if (n && !armed.current) {
            armed.current = true
            arm()
          }
        }}
        onMouseEnter={wake}
        onMouseLeave={() => !open && arm()}
        style={{
          opacity: dimmed && !open ? 0.4 : 1,
          // url() refraction (Chromium) + tone-lift; Safari/-webkit gets glass without the warp.
          backdropFilter: 'url(#liquid-glass) blur(3px) saturate(180%) brightness(1.08)',
          WebkitBackdropFilter: 'blur(3px) saturate(180%) brightness(1.08)',
          // Curved-glass depth: bright top inner edge, soft bottom light-wrap, hairline rim, drop.
          boxShadow:
            'inset 0 1px 1px rgba(255,255,255,0.8), inset 0 -1px 2px rgba(255,255,255,0.22), inset 0 0 0 1px rgba(255,255,255,0.12), 0 8px 32px rgba(0,0,0,0.18)',
        }}
        className={cn(
          'pointer-events-auto relative flex items-center gap-1 overflow-hidden rounded-full p-1',
          'border border-white/30 bg-background/45',
          'transition-opacity duration-500',
        )}
      >
        {/* top sheen — the bright specular highlight of curved glass */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-2/3 bg-gradient-to-b from-white/30 via-white/5 to-transparent"
        />
        {/* bottom inner light-wrap — thin caustic line under the glass */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-5 bottom-0 h-px bg-gradient-to-r from-transparent via-white/45 to-transparent"
        />

        <button
          type="button"
          onClick={() => {
            setOpen((o) => !o)
            wake()
          }}
          className="relative flex items-center gap-2 rounded-full py-1.5 pl-3 pr-2 text-sm font-medium hover:bg-foreground/5"
        >
          <Icon className="size-3.5 shrink-0 opacity-70" />
          <span className="max-w-[40vw] truncate sm:max-w-xs">{title}</span>
          <ChevronDown className={cn('size-3.5 shrink-0 opacity-60 transition-transform', open && 'rotate-180')} />
        </button>

        {open && (
          <div className="relative flex animate-in items-center gap-0.5 fade-in slide-in-from-left-2 duration-200">
            <span className="mx-1 h-5 w-px bg-border" />
            <Button asChild variant="ghost" size="sm" className="rounded-full">
              <Link to="/dashboard">
                <Home />
                Home
              </Link>
            </Button>
            {onReview && (
              <Button variant="ghost" size="sm" className="rounded-full" onClick={onReview}>
                <MessageSquare />
                Comments
              </Button>
            )}
            <CopyButton text={site.contentUrl} variant="ghost" size="sm" className="rounded-full" />
            {site.isOwner && <ShareDialog spaceSlug={site.spaceSlug} siteSlug={site.siteSlug} title={site.title} />}
          </div>
        )}
      </div>
    </div>
  )
}
