import { describe, expect, test } from 'bun:test'
import { bytesToBase64, transcribeVoice } from './transcribe'

// biome-ignore lint/suspicious/noExplicitAny: test stubs for the Ai binding surface.
const stubAi = (run: (...a: any[]) => unknown) => ({ run }) as any

describe('bytesToBase64 (W1-2)', () => {
  test('known bytes encode to standard base64', () => {
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=') // "hi"
    expect(bytesToBase64(new Uint8Array([0]))).toBe('AA==')
  })
  test('empty input encodes to empty string', () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe('')
  })
  test('chunks past the 32KB fromCharCode boundary and round-trips byte-exact', () => {
    const n = 70_000 // > 2 chunks of 0x8000
    const bytes = new Uint8Array(n)
    for (let i = 0; i < n; i++) bytes[i] = i % 256
    const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (c) => c.charCodeAt(0))
    expect(decoded.length).toBe(n)
    expect([...decoded]).toEqual([...bytes])
  })
})

describe('transcribeVoice (W1-3, W1-4)', () => {
  const audio = new Uint8Array([104, 105])

  test('success → trimmed transcript, called with whisper-large-v3-turbo + base64 audio (W1-3)', async () => {
    let seen: { model: string; input: { audio: string } } | undefined
    const ai = stubAi((model, input) => {
      seen = { model, input }
      return { text: '  hello world  ' }
    })
    expect(await transcribeVoice(ai, audio)).toBe('hello world')
    expect(seen?.model).toBe('@cf/openai/whisper-large-v3-turbo')
    expect(seen?.input.audio).toBe('aGk=')
  })

  test('absent binding → null (W1-4)', async () => {
    expect(await transcribeVoice(undefined, audio)).toBeNull()
  })

  test('run throws → null (W1-4)', async () => {
    const ai = stubAi(() => {
      throw new Error('AI unavailable')
    })
    expect(await transcribeVoice(ai, audio)).toBeNull()
  })

  test('empty / whitespace / missing text → null (W1-4)', async () => {
    expect(await transcribeVoice(stubAi(() => ({ text: '   ' })), audio)).toBeNull()
    expect(await transcribeVoice(stubAi(() => ({})), audio)).toBeNull()
  })
})
