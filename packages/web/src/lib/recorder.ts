// Pure helpers for the in-browser voice recorder — no React, no live MediaRecorder instance, so
// they unit-test in plain bun. The stateful hook that drives an actual recording lives in
// hooks/useMediaRecorder.ts and builds on these.
import { slugify } from './slug'

// Candidate recording containers in preference order. Opus-in-WebM is the broadest, smallest, and
// best-quality option in Chromium/Firefox; mp4/AAC covers Safari; ogg is a last resort. The server
// serves every one of these as audio (packages/api EXT_MIME), and the CSP media-src allows them.
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
] as const

// Default probe: the platform MediaRecorder support check, guarded for non-browser contexts.
function defaultIsTypeSupported(type: string): boolean {
  return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)
}

/** First recording MIME the platform supports, or '' to let MediaRecorder pick its own default.
 *  The probe is injectable (S-A) so the cascade is testable without a real MediaRecorder. */
export function pickAudioMimeType(isTypeSupported: (type: string) => boolean = defaultIsTypeSupported): string {
  return MIME_CANDIDATES.find((t) => isTypeSupported(t)) ?? ''
}

// A recording MIME (possibly with `;codecs=…`) → the file extension we name the upload with. The
// extension is what the server treats as authoritative, so it must land in AUDIO_EXTENSIONS.
const MIME_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
}

/** File extension for a recording MIME. Strips codec params; unknown/empty → webm (the default
 *  container we prefer and the server serves as audio/webm). */
export function extForMime(mime: string): string {
  const base = mime.split(';')[0].trim().toLowerCase()
  return MIME_EXT[base] ?? 'webm'
}

// Zero-padded 2-digit for the timestamp title.
const pad = (n: number): string => String(n).padStart(2, '0')

/** Human default title for a recording taken at `now`, e.g. "Recording 2026-07-08 14:05". */
export function defaultRecordingTitle(now: Date): string {
  const d = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const t = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  return `Recording ${d} ${t}`
}

/** Deterministic, always-valid slug for a recording: slugify the title, falling back to a
 *  timestamped `recording-…` when the title has no slug-able characters (e.g. all emoji). */
export function recordingSlug(title: string, now: Date): string {
  const fromTitle = slugify(title)
  if (fromTitle) return fromTitle
  return `recording-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}
