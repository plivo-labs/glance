// Pure MIME resolution for static hosting — no Worker/DOM globals, unit-testable in plain bun.
// Single source of truth for the extension→type map; `AUDIO_EXTENSIONS` is derived from it so
// the audio set can never drift from what the content worker actually serves. The web viewer
// keeps its own mirror (packages/web/src/lib/audio.ts) since packages don't cross-import.

export const EXT_MIME: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  txt: 'text/plain',
  xml: 'application/xml',
  pdf: 'application/pdf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  // MediaRecorder's default container in Chromium/Firefox; served (and comment-voice stored) as audio.
  webm: 'audio/webm',
}

/** Extensions the worker serves as audio — derived from EXT_MIME so it can't drift. */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.entries(EXT_MIME)
    .filter(([, mime]) => mime.startsWith('audio/'))
    .map(([ext]) => ext),
)

/** Lowercased final path extension, or '' for extensionless/empty. */
export function extOf(path: string): string {
  return path.includes('.') ? (path.split('.').pop() ?? '').toLowerCase() : ''
}

// Textual types are stored as UTF-8; pin the charset in the header so the browser never
// falls back to a locale default (latin-1) and double-decodes UTF-8 bytes into mojibake.
function withCharset(mime: string): string {
  return /^text\/|\/(json|xml|javascript|svg\+xml)$/.test(mime) ? `${mime}; charset=utf-8` : mime
}

// Static-hosting content-type: prefer the extension (authoritative), fall back to the
// stored upload type, then octet-stream.
export function contentType(path: string, stored: string | null): string {
  const ext = extOf(path)
  if (EXT_MIME[ext]) return withCharset(EXT_MIME[ext])
  if (stored && stored !== 'application/octet-stream') return withCharset(stored)
  return 'application/octet-stream'
}
