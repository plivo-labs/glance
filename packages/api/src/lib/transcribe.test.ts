import { describe, expect, test } from 'bun:test'
import { transcribeVoice } from './transcribe'

// Only the field transcribeVoice reads off the real whisper-large-v3-turbo response.
type WhisperResult = { text?: string }
const stubAi = (run: (...a: any[]) => WhisperResult) => ({ run }) as any

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
