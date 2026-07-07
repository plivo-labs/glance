// Server-side voice-comment transcription via Workers AI (Whisper). Kept pure and dependency-free
// so it unit-tests in plain bun: the only Worker global it touches is `btoa`, which bun provides.
//
// The `body` of a voice comment stores this transcript so the CLI/agent review loop reads
// everything as text. Transcription is best-effort: any failure (no binding, model error, empty
// result) returns null, and the caller substitutes a placeholder — a voice comment must never be
// lost because the AI was unavailable.

// whisper-large-v3-turbo takes base64 audio and returns `{ text, word_count, segments, vtt,
// transcription_info }`; we only consume `text`.
const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo'

// Base64-encode bytes without Node's Buffer (tsconfig `types: []` — no node globals). btoa needs a
// binary string; building it with one `String.fromCharCode(...bytes)` blows the argument-count
// stack limit on large inputs, so feed it in 32KB windows.
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** Transcribe recorded audio, or null if unavailable/empty. Never throws. */
export async function transcribeVoice(ai: Ai | undefined, audio: Uint8Array): Promise<string | null> {
  if (!ai) return null
  try {
    const res = await ai.run(WHISPER_MODEL, { audio: bytesToBase64(audio) })
    const text = typeof res?.text === 'string' ? res.text.trim() : ''
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}
