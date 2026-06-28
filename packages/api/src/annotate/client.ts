// Annotate-mode client, injected into uploaded HTML when ?glance_annotate=1 (gated sites only).
// BROWSER code — excluded from the worker tsconfig and bundled to a string by
// scripts/build-annotate.ts (run `bun run build:annotate` after editing this file).
//
// Trust model: this runs in the HOSTILE uploaded-HTML context. It may only OPEN UI or SUGGEST
// an anchor; it never persists status and the parent never trusts a value it sends. Phase 3
// ships the boot + the parent handshake; Phase 4 (Step 13) adds selection capture + Custom
// Highlight painting at offsets the PARENT hands down.

type Boot = { siteId: string; filePath: string; appOrigin: string }

;(() => {
  const boot = (window as unknown as { __GLANCE__?: Boot }).__GLANCE__
  if (!boot) return
  // Announce readiness to the parent (intent-only; the parent re-validates origin+source and
  // never trusts the payload as authority).
  try {
    window.parent.postMessage({ type: 'glance:ready', filePath: boot.filePath }, boot.appOrigin)
  } catch {
    // parent gone / cross-origin restriction — annotate mode simply stays inert.
  }
})()
