import { describe, expect, it, vi } from 'vitest'
import { startCapturedPointerDrag } from '../../packages/client/src/utils/pointer-drag'

class CaptureTarget extends EventTarget {
  captured = new Set<number>()
  setPointerCapture = vi.fn((pointerId: number) => this.captured.add(pointerId))
  hasPointerCapture = vi.fn((pointerId: number) => this.captured.has(pointerId))
  releasePointerCapture = vi.fn((pointerId: number) => this.captured.delete(pointerId))
}

function pointerEvent(type: string, pointerId: number, clientX = 0): Event {
  return Object.assign(new Event(type), { pointerId, clientX })
}

describe('captured pointer drag lifecycle', () => {
  it.each(['pointerup', 'pointercancel', 'lostpointercapture', 'blur'])(
    'stops idempotently on %s and ignores later pointer movement',
    (terminalEvent) => {
      const windowTarget = new EventTarget()
      const handle = new CaptureTarget()
      const move = vi.fn()
      const stop = vi.fn()
      const start = { pointerId: 17, clientX: 120, currentTarget: handle }

      const cleanup = startCapturedPointerDrag(start as unknown as PointerEvent, {
        windowTarget,
        onMove: move,
        onStop: stop,
      })

      expect(handle.setPointerCapture).toHaveBeenCalledWith(17)
      windowTarget.dispatchEvent(pointerEvent('pointermove', 17, 100))
      expect(move).toHaveBeenCalledOnce()

      const target = terminalEvent === 'lostpointercapture' ? handle : windowTarget
      target.dispatchEvent(pointerEvent(terminalEvent, 17))
      cleanup()
      windowTarget.dispatchEvent(pointerEvent('pointermove', 17, 80))

      expect(stop).toHaveBeenCalledOnce()
      expect(move).toHaveBeenCalledOnce()
      expect(handle.releasePointerCapture).toHaveBeenCalledTimes(
        terminalEvent === 'lostpointercapture' ? 0 : 1,
      )
    },
  )

  it('ignores events from a different pointer', () => {
    const windowTarget = new EventTarget()
    const handle = new CaptureTarget()
    const move = vi.fn()
    const stop = vi.fn()
    const start = { pointerId: 17, clientX: 120, currentTarget: handle }

    const cleanup = startCapturedPointerDrag(start as unknown as PointerEvent, {
      windowTarget,
      onMove: move,
      onStop: stop,
    })
    windowTarget.dispatchEvent(pointerEvent('pointermove', 99, 100))
    windowTarget.dispatchEvent(pointerEvent('pointerup', 99))

    expect(move).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    cleanup()
    expect(stop).toHaveBeenCalledOnce()
  })
})
