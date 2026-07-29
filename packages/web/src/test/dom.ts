// S-H component-test harness: registers a happy-dom browser environment as REAL globals
// (window, document, navigator, HTMLElement, Event, ...) before any test module loads, so React
// can render into it. Wired as a `bun test` preload from packages/web/bunfig.toml — preloads run
// before test files, which is the only ordering that works here: react-dom captures `document`
// and its element constructors at import time, so registering globals from inside a test file
// would come too late.
//
// packages/api needs none of this. Its happy-dom usage (annotate/locator.test.ts) constructs a
// `new Window()` and drives that document EXPLICITLY, which keeps the worker's global scope clean
// — correct there, because worker code must never assume a DOM. React has no such seam: it reads
// document/HTMLElement off globalThis, so the web package needs global registration and the api
// package must NOT get it. Scoping the preload to packages/web/bunfig.toml (rather than a root
// bunfig) is what keeps the two apart: `bun run --filter '*' test` runs each package's `bun test`
// with that package as cwd, and bun reads the bunfig from cwd.
//
// No @testing-library/jest-dom: bun's `expect` is Jest-compatible so the matchers would load, but
// every assertion this harness needs is a plain DOM property read (textarea.value, disabled,
// isConnected). One less dependency to keep aligned with the runner.
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterEach } from 'bun:test'

GlobalRegistrator.register()

// happy-dom installs `localStorage`/`sessionStorage` as accessor-only properties (getter, no
// setter), so a plain `globalThis.localStorage = fake` — which is how the pre-existing pure-logic
// tests stub storage, and how they ran before any DOM existed — throws in module scope and takes
// the whole file down. Re-expose happy-dom's own Storage objects as writable data properties: the
// DOM behaviour is unchanged for tests that want the real thing, and assignment works again for
// tests that want a fake.
for (const key of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, key, { value: globalThis[key], writable: true, configurable: true })
}

// Testing Library auto-registers this only when `afterEach` is a bare global; under bun it is an
// import from 'bun:test', so unmounting is wired explicitly. Without it, every render would leak
// its container into document.body and later queries would match stale trees.
const { cleanup } = await import('@testing-library/react')
afterEach(cleanup)
