import { Home, MessageSquare } from 'lucide-react'
import { Link } from 'react-router'
import type { ViewerSite } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ShareDialog } from '@/components/ShareDialog'

// Liquid-glass floating menu pinned to the bottom of the full-bleed preview: a compact, always-open,
// always-visible pill of icon-only actions (Home, Comments, Share). Icon-only so it doesn't hinder
// the content; labels live on hover (title/aria-label). The Comments action carries a live count
// badge of open threads so pending feedback is evident at a glance.
// The glass look layers three things: (1) an SVG feTurbulence→feDisplacementMap refraction applied
// to the backdrop (Chromium-only; degrades to plain blur elsewhere), (2) blur+saturate+brightness
// to lift the backdrop, (3) inset specular highlights + a top sheen for the curved-glass edge.
export function PreviewToolbar({
  site,
  onReview,
  commentCount = 0,
}: {
  site: ViewerSite
  onReview?: () => void
  commentCount?: number
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
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
        style={{
          // url() refraction (Chromium) + tone-lift; Safari/-webkit gets glass without the warp.
          backdropFilter: 'url(#liquid-glass) blur(3px) saturate(180%) brightness(1.08)',
          WebkitBackdropFilter: 'blur(3px) saturate(180%) brightness(1.08)',
          // Curved-glass depth: bright top inner edge, soft bottom light-wrap, hairline rim, drop.
          boxShadow:
            'inset 0 1px 1px rgba(255,255,255,0.8), inset 0 -1px 2px rgba(255,255,255,0.22), inset 0 0 0 1px rgba(255,255,255,0.12), 0 8px 32px rgba(0,0,0,0.18)',
        }}
        className={cn(
          'pointer-events-auto relative flex items-center gap-0.5 overflow-hidden rounded-full p-1',
          'border border-white/30 bg-background/45',
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

        {/* icon-only actions */}
        <div className="relative flex items-center gap-0.5">
          <Button asChild variant="ghost" size="icon" className="size-8 rounded-full" title="Home" aria-label="Home">
            <Link to="/dashboard">
              <Home />
            </Link>
          </Button>
          {onReview && (
            <Button
              variant="ghost"
              size="icon"
              className={cn('relative size-8 rounded-full', commentCount > 0 && 'text-primary')}
              onClick={onReview}
              title={commentCount > 0 ? `${commentCount} open comment${commentCount === 1 ? '' : 's'}` : 'Comments'}
              aria-label={commentCount > 0 ? `Comments, ${commentCount} open` : 'Comments'}
            >
              <MessageSquare />
              {commentCount > 0 && (
                <span className="-top-0.5 -right-0.5 absolute flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-semibold text-[10px] text-primary-foreground leading-none tabular-nums">
                  {commentCount > 9 ? '9+' : commentCount}
                </span>
              )}
            </Button>
          )}
          {site.isOwner && <ShareDialog spaceSlug={site.spaceSlug} siteSlug={site.siteSlug} title={site.title} compact />}
        </div>
      </div>
    </div>
  )
}
