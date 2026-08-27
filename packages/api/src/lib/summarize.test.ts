import { describe, expect, test } from 'bun:test'
import { summarizeSite, WORKERS_MODEL } from './summarize'

// Only the fields summarizeSite reads off a Workers AI chat response (plus `text`, the wrong-shape
// case it must reject).
type ChatResult = { response?: string; text?: string }
const stubAi = (run: (...a: any[]) => ChatResult | Promise<ChatResult>) => ({ run }) as any

describe('site summary generation', () => {
  test('C12: Workers AI uses the pinned chat contract and accepts only response text', async () => {
    let seen:
      | {
          model: string
          input: { messages: Array<{ role: string; content: string }>; max_tokens: number }
        }
      | undefined
    const ai = stubAi((model, input) => {
      seen = { model, input }
      return { response: '  text  ' }
    })

    expect(await summarizeSite({ ai }, 'page text')).toEqual({
      ok: true,
      summary: 'text',
      provider: 'workers',
      model: WORKERS_MODEL,
    })
    expect(seen?.model).toBe(WORKERS_MODEL)
    expect(seen?.input.max_tokens).toBe(1024)
    expect(seen?.input.messages).toHaveLength(2)
    expect(seen?.input.messages[0].role).toBe('system')
    expect(seen?.input.messages[1]).toEqual({ role: 'user', content: 'page text' })

    expect(await summarizeSite({ ai: stubAi(() => ({ text: 'x' })) }, 'page text')).toEqual({
      ok: false,
    })
    expect(await summarizeSite({ ai: stubAi(() => ({})) }, 'page text')).toEqual({ ok: false })
    expect(
      await summarizeSite(
        {
          ai: stubAi(async () => {
            throw new Error('Workers AI unavailable')
          }),
        },
        'page text',
      ),
    ).toEqual({ ok: false })
  })

  test('C11: blank page text returns failure without calling the provider', async () => {
    for (const pageText of ['', '   ']) {
      let workersCalls = 0
      const ai = stubAi(() => {
        workersCalls++
        return { response: 'summary' }
      })
      expect(await summarizeSite({ ai }, pageText)).toEqual({ ok: false })
      expect(workersCalls).toBe(0)
    }
  })

  test('no AI binding returns failure', async () => {
    expect(await summarizeSite({}, 'page text')).toEqual({ ok: false })
  })
})
