import { mkdir } from 'fs/promises'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core'
import type {
  SteelPageState,
  SteelRuntimeAdapter,
  SteelRuntimeSession,
} from './steel-browser-service'

interface ChromiumConnector {
  connectOverCDP(endpointURL: string, options?: { timeout?: number }): Promise<Browser>
}

interface RuntimeOptions {
  baseUrl: string
  userDataRoot: string
  chromium?: ChromiumConnector
  fetchImpl?: typeof fetch
  egressProxy?: { start(): Promise<string>; close(): Promise<void> }
}

interface SnapshotRef {
  selector: string
  role: string
  name: string
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 160) || 'browser'
}

function normalizeUrl(url: string, allowBlank = false): string {
  const input = String(url || '').trim()
  if (allowBlank && (!input || input === 'about:blank')) return 'about:blank'
  const withProtocol = /^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`
  const parsed = new URL(withProtocol)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only HTTP and HTTPS browser URLs are allowed')
  parsed.username = ''
  parsed.password = ''
  return parsed.toString()
}

class SteelHttpRuntimeSession implements SteelRuntimeSession {
  readonly id: string
  private readonly baseUrl: URL
  private readonly browser: Browser
  private readonly context: BrowserContext
  private readonly fetchImpl: typeof fetch
  private readonly refs = new Map<string, Map<string, SnapshotRef>>()
  private readonly pageIds = new WeakMap<Page, string>()
  private readonly pagesById = new Map<string, Page>()
  private released = false

  constructor(options: { id: string; baseUrl: URL; browser: Browser; context: BrowserContext; fetchImpl: typeof fetch }) {
    this.id = options.id
    this.baseUrl = options.baseUrl
    this.browser = options.browser
    this.context = options.context
    this.fetchImpl = options.fetchImpl
  }

  async initialize(): Promise<void> {
    for (const page of this.context.pages()) await this.trackPage(page)
    this.context.on?.('page', page => { void this.trackPage(page) })
  }

  async listPages(): Promise<SteelPageState[]> {
    const pages = this.context.pages().filter(page => !page.isClosed())
    const result: SteelPageState[] = []
    for (const page of pages) {
      const id = await this.trackPage(page)
      result.push(await this.pageState(page, id))
    }
    return result
  }

  async createPage(url: string): Promise<SteelPageState> {
    const page = await this.context.newPage()
    const id = await this.trackPage(page)
    const normalized = normalizeUrl(url, true)
    if (normalized !== 'about:blank') await page.goto(normalized, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    return await this.pageState(page, id)
  }

  async closePage(pageId: string): Promise<void> {
    const page = this.requirePage(pageId)
    await page.close()
    this.pagesById.delete(pageId)
    this.refs.delete(pageId)
  }

  async activatePage(pageId: string): Promise<void> {
    await this.requirePage(pageId).bringToFront()
  }

  async navigate(pageId: string, url: string): Promise<SteelPageState> {
    const page = this.requirePage(pageId)
    await page.goto(normalizeUrl(url), { waitUntil: 'domcontentloaded', timeout: 30_000 })
    this.refs.delete(pageId)
    return await this.pageState(page, pageId)
  }

  async navigationAction(pageId: string, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<SteelPageState> {
    const page = this.requirePage(pageId)
    if (action === 'back') await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null)
    else if (action === 'forward') await page.goForward({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null)
    else if (action === 'reload') await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    else {
      const session = await this.context.newCDPSession(page)
      await session.send('Page.stopLoading').finally(() => session.detach())
    }
    this.refs.delete(pageId)
    return await this.pageState(page, pageId)
  }

  async snapshot(pageId: string): Promise<unknown> {
    const page = this.requirePage(pageId)
    const snapshotId = randomUUID()
    const nodes = await page.locator('a,button,input,textarea,select,[role],[tabindex]').evaluateAll((elements: Element[]) => elements.slice(0, 500).map((element, index) => {
      const html = element as HTMLElement
      const role = element.getAttribute('role') || element.tagName.toLowerCase()
      const name = element.getAttribute('aria-label') || element.getAttribute('title') || (html.innerText || '').trim() || (element as HTMLInputElement).value || ''
      return { ref: `@e${index + 1}`, role, name: name.slice(0, 500), selector: `[data-hermes-steel-ref="${index + 1}"]` }
    }))
    await page.locator('a,button,input,textarea,select,[role],[tabindex]').evaluateAll((elements: Element[]) => {
      elements.slice(0, 500).forEach((element, index) => element.setAttribute('data-hermes-steel-ref', String(index + 1)))
    })
    this.refs.set(pageId, new Map(nodes.map(node => [node.ref, { selector: node.selector, role: node.role, name: node.name }])))
    const text = nodes.map(node => `${node.ref} ${node.role} name=${JSON.stringify(node.name)}`).join('\n')
    return { tabId: pageId, snapshotId, url: page.url(), title: await page.title(), nodes: nodes.map(({ selector: _selector, ...node }) => node), text }
  }

  async readText(pageId: string, input: Record<string, unknown>): Promise<unknown> {
    const page = this.requirePage(pageId)
    const ref = String(input.ref || '')
    const item = this.refs.get(pageId)?.get(ref)
    if (!item) throw new Error('Browser snapshot reference is stale or invalid')
    const mode = input.mode === 'textContent' ? 'textContent' : 'innerText'
    const source = await page.locator(item.selector).evaluate((element: Element, selectedMode: string) => selectedMode === 'textContent' ? element.textContent || '' : (element as HTMLElement).innerText || '', mode)
    const offset = Math.max(0, Number(input.offset) || 0)
    const limit = Math.max(1, Math.min(20_000, Number(input.limit) || 4_000))
    const text = source.slice(offset, offset + limit)
    return { tabId: pageId, snapshotId: String(input.snapshotId || input.snapshot_id || ''), ref, mode, offset, limit, text, totalLength: source.length, returnedLength: text.length, hasMore: offset + text.length < source.length, ...(offset + text.length < source.length ? { nextOffset: offset + text.length } : {}) }
  }

  async interact(pageId: string, action: Record<string, unknown>): Promise<SteelPageState> {
    const page = this.requirePage(pageId)
    const kind = String(action.action || '')
    if (kind === 'click' || kind === 'type') {
      const ref = String(action.ref || '')
      const item = this.refs.get(pageId)?.get(ref)
      if (!item) throw new Error('Browser snapshot reference is stale or invalid')
      const locator = page.locator(item.selector)
      if (kind === 'click') await locator.click({ timeout: 10_000 })
      else await locator.fill(String(action.text || ''))
    } else if (kind === 'press') {
      await page.keyboard.press(String(action.key || ''))
    } else if (kind === 'scroll') {
      const pixels = Math.max(1, Math.min(10_000, Number(action.pixels) || 600))
      const direction = String(action.direction || 'down')
      await page.mouse.wheel(direction === 'left' ? -pixels : direction === 'right' ? pixels : 0, direction === 'up' ? -pixels : direction === 'down' ? pixels : 0)
    } else {
      throw new Error('Unsupported browser interaction')
    }
    this.refs.delete(pageId)
    return await this.pageState(page, pageId)
  }

  async screenshot(pageId: string, fullPage: boolean): Promise<unknown> {
    const page = this.requirePage(pageId)
    const data = await page.screenshot({ type: 'png', fullPage })
    const viewport = page.viewportSize() || { width: 0, height: 0 }
    return { tabId: pageId, url: page.url(), title: await page.title(), mediaType: 'image/png', data: Buffer.from(data).toString('base64'), width: viewport.width, height: viewport.height }
  }

  async consoleEntries(): Promise<unknown[]> { return [] }
  async clearConsole(): Promise<void> { return undefined }

  async cancelAgentOperation(pageId: string): Promise<void> {
    const page = this.requirePage(pageId)
    const session = await this.context.newCDPSession(page)
    await session.send('Page.stopLoading').finally(() => session.detach())
    this.refs.delete(pageId)
  }

  castWebSocketUrl(pageId: string): string {
    const url = new URL('/v1/sessions/cast', this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('pageId', pageId)
    return url.toString()
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    await this.browser.close().catch(() => undefined)
    await this.fetchImpl(new URL(`/v1/sessions/${encodeURIComponent(this.id)}/release`, this.baseUrl), {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined)
  }

  private requirePage(pageId: string): Page {
    const page = this.pagesById.get(pageId)
    if (!page || page.isClosed()) throw new Error('Browser tab not found')
    return page
  }

  private async trackPage(page: Page): Promise<string> {
    const known = this.pageIds.get(page)
    if (known) return known
    const session: CDPSession = await this.context.newCDPSession(page)
    const result = await session.send('Target.getTargetInfo') as { targetInfo?: { targetId?: string } }
    await session.detach()
    const id = String(result.targetInfo?.targetId || randomUUID())
    this.pageIds.set(page, id)
    this.pagesById.set(id, page)
    return id
  }

  private async pageState(page: Page, id: string): Promise<SteelPageState> {
    return {
      id,
      title: await page.title().catch(() => ''),
      url: page.url(),
      loading: false,
      canGoBack: false,
      canGoForward: false,
      crashed: page.isClosed(),
    }
  }
}

export class SteelHttpRuntimeAdapter implements SteelRuntimeAdapter {
  private readonly baseUrl: URL
  private readonly userDataRoot: string
  private readonly chromium: ChromiumConnector
  private readonly fetchImpl: typeof fetch
  private readonly egressProxy?: { start(): Promise<string>; close(): Promise<void> }

  constructor(options: RuntimeOptions) {
    this.baseUrl = new URL(options.baseUrl)
    this.userDataRoot = resolve(options.userDataRoot)
    this.chromium = options.chromium || chromium
    this.fetchImpl = options.fetchImpl || fetch
    this.egressProxy = options.egressProxy
  }

  async startSession(input: { ownerKey: string; profile: string }): Promise<SteelRuntimeSession> {
    const requestedId = randomUUID()
    const userDataDir = join(this.userDataRoot, safeSegment(input.ownerKey))
    await mkdir(userDataDir, { recursive: true, mode: 0o700 })
    const proxyUrl = await this.egressProxy?.start()
    const response = await this.fetchImpl(new URL('/v1/sessions', this.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: requestedId, persist: true, userDataDir, headless: true, ...(proxyUrl ? { proxyUrl } : {}) }),
      signal: AbortSignal.timeout(45_000),
    })
    const payload = await response.json().catch(() => null) as { id?: string; websocketUrl?: string; message?: string } | null
    if (!response.ok || !payload?.id || !payload.websocketUrl) throw new Error(payload?.message || `Steel Browser session failed with HTTP ${response.status}`)
    const endpoint = new URL(payload.websocketUrl)
    if ((endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') || endpoint.username || endpoint.password) {
      throw new Error('Steel Browser returned an invalid CDP endpoint')
    }
    endpoint.protocol = this.baseUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    endpoint.host = this.baseUrl.host
    const browser = await this.chromium.connectOverCDP(endpoint.toString(), { timeout: 30_000 })
    const context = browser.contexts()[0]
    if (!context) {
      await browser.close().catch(() => undefined)
      throw new Error('Steel Browser did not expose a browser context')
    }
    const session = new SteelHttpRuntimeSession({ id: payload.id, baseUrl: this.baseUrl, browser, context, fetchImpl: this.fetchImpl })
    await session.initialize()
    return session
  }

  async shutdown(): Promise<void> {
    await this.egressProxy?.close()
  }
}
