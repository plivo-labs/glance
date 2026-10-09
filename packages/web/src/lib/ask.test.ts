import { describe, expect, test } from 'bun:test'
import { ApiError } from '@/lib/api'
import { askStream } from './ask'

// askStream bypasses api.ts's JSON-parsing wrapper on purpose (see ask.ts's header comment), so it
// is tested directly against a mocked `fetch` and a real ReadableStream body — the same shape a
// Workers-AI SSE passthrough actually produces, split across chunk boundaries to prove the client
// buffers a partial line rather than losing or mis-parsing it.

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status })
}

function stubFetch(res: Response) {
  globalThis.fetch = (() => Promise.resolve(res)) as unknown as typeof fetch
}

const site = { spaceSlug: 'acme', siteSlug: 'docs' }
const body = { question: 'what is this?', quote: 'the quick brown fox' }

describe('askStream', () => {
  test('emits tokens in order, across a line split mid-JSON between two chunks', async () => {
    // 'data: {"response":"world"}\n' split right through the JSON payload.
    const res = sseResponse([
      'data: {"response":"hello "}\n',
      'data: {"resp',
      'onse":"world"}\n',
      'data: [DONE]\n',
    ])
    stubFetch(res)
    const tokens: string[] = []
    await askStream(site, body, (t) => tokens.push(t))
    expect(tokens).toEqual(['hello ', 'world'])
  })

  test('Responses-API frames: output_text.delta emits, lifecycle events are silent', async () => {
    // What a Workers-AI CATALOG model (openai/gpt-5.6-luna — see routes/ask.ts's ASK_MODEL) streams:
    // typed events where only response.output_text.delta carries text.
    const res = sseResponse([
      'data: {"type":"response.created"}\n',
      'data: {"type":"response.output_text.delta","delta":"hello "}\n',
      'data: {"type":"response.output_text.delta","delta":"world"}\n',
      'data: {"type":"response.completed"}\n',
      'data: [DONE]\n',
    ])
    stubFetch(res)
    const tokens: string[] = []
    await askStream(site, body, (t) => tokens.push(t))
    expect(tokens).toEqual(['hello ', 'world'])
  })

  test('chat-completion chunks: delta.content emits, delta.reasoning is skipped', async () => {
    // What gpt-oss streams under the chat `messages` shape (routes/ask.ts's ASK_MODEL): the
    // answer in delta.content, the chain-of-thought in delta.reasoning — never shown.
    const res = sseResponse([
      'data: {"choices":[{"delta":{"content":"","role":"assistant"}}]}\n',
      'data: {"choices":[{"delta":{"reasoning":"User wants a greeting"}}]}\n',
      'data: {"choices":[{"delta":{"content":"hello "}}]}\n',
      'data: {"choices":[{"delta":{"content":"world"}}]}\n',
      'data: [DONE]\n',
    ])
    stubFetch(res)
    const tokens: string[] = []
    await askStream(site, body, (t) => tokens.push(t))
    expect(tokens).toEqual(['hello ', 'world'])
  })

  test('[DONE] terminates the stream — anything after it is ignored', async () => {
    const res = sseResponse(['data: {"response":"a"}\n', 'data: [DONE]\n', 'data: {"response":"b"}\n'])
    stubFetch(res)
    const tokens: string[] = []
    await askStream(site, body, (t) => tokens.push(t))
    expect(tokens).toEqual(['a'])
  })

  test('an unparseable line is skipped, not thrown', async () => {
    const res = sseResponse(['data: not-json\n', 'data: {"response":"ok"}\n', 'data: [DONE]\n'])
    stubFetch(res)
    const tokens: string[] = []
    await askStream(site, body, (t) => tokens.push(t))
    expect(tokens).toEqual(['ok'])
  })

  test('a non-2xx response throws ApiError with the server-provided message', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 }))) as unknown as typeof fetch
    await expect(askStream(site, body, () => {})).rejects.toThrow(ApiError)
    try {
      await askStream(site, body, () => {})
      throw new Error('expected askStream to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).status).toBe(429)
      expect((e as ApiError).message).toBe('rate limited')
    }
  })

  test('a non-2xx response with a non-JSON body falls back to statusText', async () => {
    globalThis.fetch = (() => Promise.resolve(new Response('boom', { status: 500, statusText: 'Internal Server Error' }))) as unknown as typeof fetch
    try {
      await askStream(site, body, () => {})
      throw new Error('expected askStream to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).status).toBe(500)
      expect((e as ApiError).message).toBe('Internal Server Error')
    }
  })
})
