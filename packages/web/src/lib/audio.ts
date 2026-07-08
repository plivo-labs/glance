// Audio playback helpers for the first-class audio viewer (AudioView) — pure, unit-tested.

// Mirrors the audio EXT_MIME entries the content worker serves (packages/api/src/content.ts) —
// same extensions, same authority rule (extension decides, not the stored/uploaded MIME).
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'ogg', 'oga', 'flac', 'aac', 'webm'])

/** True when `path`'s extension is one the content worker serves as audio. Used by the viewer
 *  to pick the AudioView (native `<audio>` player) over the sandboxed HTML iframe. */
export function isAudioFile(path: string): boolean {
  const ext = path.includes('.') ? (path.split('.').pop() ?? '').toLowerCase() : ''
  return AUDIO_EXTENSIONS.has(ext)
}

/** Format a playback position (seconds) as `m:ss` — no leading zero on minutes, seconds always
 *  zero-padded. E.g. 65.4 -> "1:05", 3 -> "0:03". Negative/NaN/Infinity clamp to "0:00". */
export function formatTimestamp(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** The `[m:ss] ` prefix the composer's timestamp button inserts into the comment body. */
export function timestampPrefix(seconds: number): string {
  return `[${formatTimestamp(seconds)}] `
}
