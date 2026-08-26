type Listener = (e: { data: unknown }) => void

/** Enough of a WebSocket for the realtime clients under test (commentStream, dbBroker, and the
 *  viewer's rail), plus the levers a test needs: the url/protocols it was dialled with, what the
 *  client put on the wire, and whether it was closed.
 *
 *  The production clients register through `addEventListener`, so the fake accumulates listeners
 *  per type. `onopen`/`onclose`/`onmessage` here are NOT handler slots — they are test-side
 *  triggers standing in for the browser dispatching the real event. */
export class FakeSocket {
  private readonly listeners: { open: Listener[]; message: Listener[]; close: Listener[] } = {
    open: [],
    message: [],
    close: [],
  }
  closed = false
  /** Client → server: every frame this socket was asked to send, in order. */
  sent: string[] = []

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}

  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
  }
  addEventListener(type: 'open' | 'message' | 'close', fn: Listener) {
    this.listeners[type].push(fn)
  }

  onopen() {
    for (const fn of this.listeners.open) fn({ data: undefined })
  }
  onclose() {
    for (const fn of this.listeners.close) fn({ data: undefined })
  }
  onmessage(e: { data: unknown }) {
    for (const fn of this.listeners.message) fn(e)
  }

  /** Server → client: one frame, exactly as given — no encoding. Lets a test prove a
   *  non-string-payload guard by handing over something that already isn't a string. */
  emitRaw(data: unknown) {
    this.onmessage({ data })
  }
  /** Server → client: one frame, JSON-encoded like the real wire. A plain object is convenience
   *  sugar; a string (including deliberately malformed JSON) passes through untouched. */
  emit(data: unknown) {
    this.emitRaw(typeof data === 'string' ? data : JSON.stringify(data))
  }
}
