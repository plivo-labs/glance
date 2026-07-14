import { useCallback, useRef } from 'react'

export function MountSensor({ onMount }: { onMount: () => void }) {
  const onMountRef = useRef(onMount)
  onMountRef.current = onMount

  // Keep mount-triggered work on a plain sensor element: Radix recomposes content refs on every
  // render, which would detach and reattach a callback ref and repeat the work in a loop.
  const sensorRef = useCallback((node: HTMLDivElement | null) => {
    if (node) onMountRef.current()
  }, [])

  return <div ref={sensorRef} hidden aria-hidden="true" />
}
