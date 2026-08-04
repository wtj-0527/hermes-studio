export type ContainedViewPointInput = {
  clientX: number
  clientY: number
  rectLeft: number
  rectTop: number
  rectWidth: number
  rectHeight: number
  bitmapWidth: number
  bitmapHeight: number
  targetWidth?: number
  targetHeight?: number
}

export type BrowserViewPoint = { x: number; y: number }

export function mapContainedViewPoint(input: ContainedViewPointInput): BrowserViewPoint | null {
  const {
    clientX,
    clientY,
    rectLeft,
    rectTop,
    rectWidth,
    rectHeight,
    bitmapWidth,
    bitmapHeight,
    targetWidth = bitmapWidth,
    targetHeight = bitmapHeight,
  } = input
  if (![clientX, clientY, rectLeft, rectTop, rectWidth, rectHeight, bitmapWidth, bitmapHeight, targetWidth, targetHeight].every(Number.isFinite)) return null
  if (rectWidth <= 0 || rectHeight <= 0 || bitmapWidth <= 0 || bitmapHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) return null

  const scale = Math.min(rectWidth / bitmapWidth, rectHeight / bitmapHeight)
  const renderedWidth = bitmapWidth * scale
  const renderedHeight = bitmapHeight * scale
  const offsetX = (rectWidth - renderedWidth) / 2
  const offsetY = (rectHeight - renderedHeight) / 2
  const renderedX = clientX - rectLeft - offsetX
  const renderedY = clientY - rectTop - offsetY
  const epsilon = 1e-6
  if (renderedX < -epsilon || renderedY < -epsilon || renderedX > renderedWidth + epsilon || renderedY > renderedHeight + epsilon) return null

  return {
    x: Math.max(0, Math.min(targetWidth - 1, Math.round((renderedX / renderedWidth) * targetWidth))),
    y: Math.max(0, Math.min(targetHeight - 1, Math.round((renderedY / renderedHeight) * targetHeight))),
  }
}
