import { describe, expect, it } from 'vitest'
import { mapContainedViewPoint } from '../../packages/server/src/services/browser/live-view-geometry'

describe('managed browser live-view geometry', () => {
  it('subtracts vertical letterboxing before mapping a pointer to bitmap coordinates', () => {
    expect(mapContainedViewPoint({
      clientX: 458.5,
      clientY: 129.2,
      rectLeft: 0,
      rectTop: 0,
      rectWidth: 917,
      rectHeight: 736,
      bitmapWidth: 1920,
      bitmapHeight: 1040,
    })).toEqual({ x: 960, y: 20 })
  })

  it('subtracts horizontal letterboxing before mapping a pointer to bitmap coordinates', () => {
    expect(mapContainedViewPoint({
      clientX: 260,
      clientY: 250,
      rectLeft: 0,
      rectTop: 0,
      rectWidth: 1000,
      rectHeight: 500,
      bitmapWidth: 1000,
      bitmapHeight: 1000,
    })).toEqual({ x: 20, y: 500 })
  })

  it('rejects pointer input in letterbox padding', () => {
    expect(mapContainedViewPoint({
      clientX: 400,
      clientY: 40,
      rectLeft: 0,
      rectTop: 0,
      rectWidth: 800,
      rectHeight: 800,
      bitmapWidth: 1600,
      bitmapHeight: 900,
    })).toBeNull()
  })

  it('maps a downscaled preview back to the full CDP viewport', () => {
    expect(mapContainedViewPoint({
      clientX: 400,
      clientY: 175,
      rectLeft: 0,
      rectTop: 0,
      rectWidth: 800,
      rectHeight: 800,
      bitmapWidth: 1280,
      bitmapHeight: 720,
      targetWidth: 1920,
      targetHeight: 1080,
    })).toEqual({ x: 960, y: 0 })
  })

  it('clamps exact rendered-image edges to valid bitmap coordinates', () => {
    expect(mapContainedViewPoint({
      clientX: 800,
      clientY: 625,
      rectLeft: 0,
      rectTop: 175,
      rectWidth: 800,
      rectHeight: 450,
      bitmapWidth: 1600,
      bitmapHeight: 900,
    })).toEqual({ x: 1599, y: 899 })
  })
})
