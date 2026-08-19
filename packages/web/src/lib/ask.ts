import { ApiError } from '@/lib/api'

// Streaming client for POST /api/sites/:space/:site/ask. Deliberately bypasses `api.ts`'s
// `request()` wrapper — that wrapper reads the WHOLE body via `res.json()`, which can only resolve
// once the stream ends, defeating the point of a token-by-token answer. This is a plain `fetch`
// instead, wired to the same ApiError contract so callers still get one error shape.

export type AskSite = { spaceSlug: string; siteSlug: string }
export type AskBody = { question: string; quote: string; blockText?: string }

/** Streams the answer via Workers-AI's SSE passthrough, calling `onToken` with each `.response`
 *  chunk as it arrives. Resolves once the stream ends (`data: [DONE]` or the body closes). */
export async function askStream(site: AskSite, body: AskBody, onToken: (text: string) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`/api/sites/${site.spaceSlug}/${site.siteSlug}/ask`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    let message = res.statusText
    try {
      const errBody = (await res.json()) as { error?: string }
      if (errBody?.error) message = errBody.error
    } catch {
      // non-JSON error body — keep statusText
    }
    throw new ApiError(res.status, message)
  }
  if (!res.body) return // nothing to stream (e.g. a 204, or a fetch polyfill without body support)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  // SSE lines can split across chunk boundaries — this carries a trailing partial line into the
  // next chunk instead of losing or mis-parsing it.
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? '' // last element is either '' (buffer ended on \n) or a partial line
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice('data: '.length)
      if (payload === '[DONE]') return
      try {
        // Three token shapes, one loop — which one arrives depends on the model the ask route
        // pins and the request shape it sends (see ASK_MODEL in routes/ask.ts):
        //   • `{response}` — Workers-AI-native frames (llama and friends)
        //   • chat-completion chunks — what gpt-oss streams under the chat `messages` shape; the
        //     answer rides `choices[0].delta.content`, and `.delta.reasoning` (the model's
        //     chain-of-thought) is deliberately NOT shown
        //   • `response.output_text.delta` typed events — frontier catalog models via the
        //     Responses API; other event types (response.created, …) are lifecycle noise
        const parsed = JSON.parse(payload) as {
          response?: unknown
          type?: unknown
          delta?: unknown
          choices?: Array<{ delta?: { content?: unknown } }>
        }
        const chat = parsed.choices?.[0]?.delta?.content
        if (typeof parsed.response === 'string' && parsed.response) onToken(parsed.response)
        else if (typeof chat === 'string' && chat) onToken(chat)
        else if (parsed.type === 'response.output_text.delta' && typeof parsed.delta === 'string' && parsed.delta) onToken(parsed.delta)
      } catch {
        // an unparseable frame is noise, not a reason to abort a stream that is otherwise fine
      }
    }
  }
}
