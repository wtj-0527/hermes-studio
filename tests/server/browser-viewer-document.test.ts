import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { viewerDocument } from '../../packages/server/src/controllers/browser'

class FakeWebSocket {
  static OPEN = 1
  readonly OPEN = 1
  readyState = 1
  binaryType = ''
  onmessage: ((event: MessageEvent) => void) | null = null
  sent: string[] = []
  constructor(_url: string) {
    sockets.push(this)
  }
  send(value: string) {
    this.sent.push(value)
  }
}

const sockets: FakeWebSocket[] = []

function createViewer(options: { autoLoadImages?: boolean } = {}) {
  sockets.length = 0
  const animationFrames: FrameRequestCallback[] = []
  const pendingImages: Array<{ src: string; flush(): void }> = []
  const drawnSources: string[] = []
  const dom = new JSDOM(viewerDocument('/view/socket'), {
    url: 'https://studio.example.test/api/browser/view/token',
    runScripts: 'dangerously',
    beforeParse(window) {
      Object.defineProperty(window, 'WebSocket', { value: FakeWebSocket })
      Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', { value: () => ({ drawImage(image: { src?: string }) { drawnSources.push(String(image.src || '')) } }) })
      Object.defineProperty(window, 'requestAnimationFrame', { value: (callback: FrameRequestCallback) => { animationFrames.push(callback); return animationFrames.length } })
      Object.defineProperty(window, 'Image', { value: class {
        naturalWidth = 1280
        naturalHeight = 720
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        private value = ''
        get src() { return this.value }
        set src(value: string) {
          this.value = value
          if (options.autoLoadImages === false) pendingImages.push({ src: value, flush: () => this.onload?.() })
          else this.onload?.()
        }
      } })
    },
  })
  const canvas = dom.window.document.querySelector('canvas')!
  Object.defineProperty(canvas, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, width: 800, height: 800, right: 800, bottom: 800, x: 0, y: 0, toJSON() {} }),
  })
  return {
    dom,
    canvas,
    socket: sockets[0],
    flushAnimationFrame() {
      const callbacks = animationFrames.splice(0)
      callbacks.forEach(callback => callback(0))
    },
    flushNextImage() {
      pendingImages.shift()?.flush()
    },
    pendingImages,
    drawnSources,
  }
}

describe('managed browser viewer document', () => {
  it('maps input against the rendered contain rectangle rather than the canvas box', () => {
    const { dom, canvas, socket } = createViewer()
    canvas.dispatchEvent(new dom.window.MouseEvent('mousedown', { clientX: 400, clientY: 175, button: 0, bubbles: true }))
    const sent = JSON.parse(socket.sent[0])
    expect(sent.event).toMatchObject({ type: 'mousePressed', x: 640, y: 0 })
  })

  it('does not forward pointer input from letterbox padding', () => {
    const { dom, canvas, socket } = createViewer()
    canvas.dispatchEvent(new dom.window.MouseEvent('mousedown', { clientX: 400, clientY: 40, button: 0, bubbles: true }))
    expect(socket.sent).toEqual([])
  })

  it('releases a pressed mouse at the last valid point when pointerup lands in letterbox padding', () => {
    const { dom, canvas, socket, flushAnimationFrame } = createViewer()
    canvas.dispatchEvent(new dom.window.MouseEvent('mousedown', { clientX: 400, clientY: 400, button: 0, bubbles: true }))
    canvas.dispatchEvent(new dom.window.MouseEvent('mousemove', { clientX: 500, clientY: 400, bubbles: true }))
    flushAnimationFrame()
    canvas.dispatchEvent(new dom.window.MouseEvent('mouseup', { clientX: 400, clientY: 40, button: 0, bubbles: true }))
    expect(socket.sent).toHaveLength(3)
    const moved = JSON.parse(socket.sent[1]).event
    const released = JSON.parse(socket.sent[2]).event
    expect(released).toMatchObject({ type: 'mouseReleased', x: moved.x, y: moved.y })
  })

  it('releases a pressed mouse at the last valid point when the embedded viewer loses focus', () => {
    const { dom, canvas, socket, flushAnimationFrame } = createViewer()
    canvas.dispatchEvent(new dom.window.MouseEvent('mousedown', { clientX: 400, clientY: 400, button: 0, bubbles: true }))
    canvas.dispatchEvent(new dom.window.MouseEvent('mousemove', { clientX: 500, clientY: 400, bubbles: true }))
    flushAnimationFrame()
    dom.window.dispatchEvent(new dom.window.Event('blur'))
    dom.window.dispatchEvent(new dom.window.Event('blur'))
    expect(socket.sent).toHaveLength(3)
    const moved = JSON.parse(socket.sent[1]).event
    expect(JSON.parse(socket.sent[2]).event).toMatchObject({
      type: 'mouseReleased', x: moved.x, y: moved.y, button: 'left',
    })
  })

  it('ignores malformed screencast dimensions and retains finite positive target coordinates', () => {
    const { dom, canvas, socket } = createViewer()
    socket.onmessage?.(new dom.window.MessageEvent('message', { data: JSON.stringify({
      data: 'jpeg-base64',
      metadata: { deviceWidth: -1920, deviceHeight: 'Infinity' },
    }) }))
    canvas.dispatchEvent(new dom.window.MouseEvent('mousedown', { clientX: 400, clientY: 175, button: 0, bubbles: true }))
    expect(JSON.parse(socket.sent[0]).event).toMatchObject({ type: 'mousePressed', x: 640, y: 0 })
  })

  it('maps a downscaled preview frame to the full CDP viewport from screencast metadata', () => {
    const { dom, canvas, socket } = createViewer()
    socket.onmessage?.(new dom.window.MessageEvent('message', { data: JSON.stringify({
      data: 'jpeg-base64',
      metadata: { deviceWidth: 1920, deviceHeight: 1080 },
    }) }))
    canvas.dispatchEvent(new dom.window.MouseEvent('mousedown', { clientX: 400, clientY: 175, button: 0, bubbles: true }))
    const sent = JSON.parse(socket.sent[0])
    expect(sent.event).toMatchObject({ type: 'mousePressed', x: 960, y: 0 })
  })

  it('coalesces mousemove input to the latest point in one animation frame', () => {
    const { dom, canvas, socket, flushAnimationFrame } = createViewer()
    canvas.dispatchEvent(new dom.window.MouseEvent('mousemove', { clientX: 300, clientY: 300, bubbles: true }))
    canvas.dispatchEvent(new dom.window.MouseEvent('mousemove', { clientX: 500, clientY: 300, bubbles: true }))
    expect(socket.sent).toEqual([])
    flushAnimationFrame()
    expect(socket.sent).toHaveLength(1)
    expect(JSON.parse(socket.sent[0]).event).toMatchObject({ type: 'mouseMoved', x: 800 })
  })

  it('drops superseded JPEG frames while one frame is still decoding', () => {
    const { dom, socket, flushNextImage, pendingImages, drawnSources } = createViewer({ autoLoadImages: false })
    const emit = (data: string) => socket.onmessage?.(new dom.window.MessageEvent('message', { data: JSON.stringify({ data }) }))
    emit('frame-a')
    emit('frame-b')
    emit('frame-c')
    expect(pendingImages.map(image => image.src)).toEqual(['data:image/jpeg;base64,frame-a'])
    flushNextImage()
    expect(pendingImages.map(image => image.src)).toEqual(['data:image/jpeg;base64,frame-c'])
    flushNextImage()
    expect(drawnSources).toEqual([
      'data:image/jpeg;base64,frame-a',
      'data:image/jpeg;base64,frame-c',
    ])
  })
})
