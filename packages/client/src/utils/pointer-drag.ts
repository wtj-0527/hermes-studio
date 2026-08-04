export interface CapturedPointerDragOptions {
  windowTarget?: EventTarget
  onMove: (event: PointerEvent) => void
  onStop: () => void
}

type PointerCaptureTarget = EventTarget & {
  setPointerCapture(pointerId: number): void
  hasPointerCapture?(pointerId: number): boolean
  releasePointerCapture(pointerId: number): void
}

export function startCapturedPointerDrag(
  event: PointerEvent,
  options: CapturedPointerDragOptions,
): () => void {
  const pointerId = event.pointerId
  const handle = event.currentTarget as PointerCaptureTarget | null
  const windowTarget = options.windowTarget ?? window
  let stopped = false

  if (!handle || typeof handle.setPointerCapture !== 'function') {
    throw new Error('Pointer drag requires a capture-capable event target')
  }

  const isTrackedPointer = (candidate: Event) => {
    const candidateId = (candidate as PointerEvent).pointerId
    return candidateId === undefined || candidateId === pointerId
  }
  const move = (candidate: Event) => {
    if (!stopped && isTrackedPointer(candidate)) options.onMove(candidate as PointerEvent)
  }
  const finish = (candidate?: Event) => {
    if (stopped || (candidate && !isTrackedPointer(candidate))) return
    stopped = true
    windowTarget.removeEventListener('pointermove', move)
    windowTarget.removeEventListener('pointerup', finish)
    windowTarget.removeEventListener('pointercancel', finish)
    windowTarget.removeEventListener('blur', finish)
    handle.removeEventListener('lostpointercapture', finish)
    if (candidate?.type !== 'lostpointercapture'
      && (!handle.hasPointerCapture || handle.hasPointerCapture(pointerId))) {
      handle.releasePointerCapture(pointerId)
    }
    options.onStop()
  }

  handle.setPointerCapture(pointerId)
  windowTarget.addEventListener('pointermove', move)
  windowTarget.addEventListener('pointerup', finish)
  windowTarget.addEventListener('pointercancel', finish)
  windowTarget.addEventListener('blur', finish)
  handle.addEventListener('lostpointercapture', finish)

  return () => finish()
}
