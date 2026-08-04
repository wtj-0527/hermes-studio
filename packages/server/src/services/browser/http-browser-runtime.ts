import { randomUUID } from 'crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Worker } from 'node:worker_threads'
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core'
import type {
  BrowserPageState,
  BrowserRuntimeAdapter,
  BrowserRuntimeSession,
} from './managed-browser-service'

interface ChromiumConnector {
  connectOverCDP(endpointURL: string, options?: { timeout?: number; headers?: Record<string, string> }): Promise<Browser>
}

type NormalizedInteraction =
  | { kind: 'click'; selector: string }
  | { kind: 'type'; selector: string; text: string }
  | { kind: 'press'; key: string }
  | { kind: 'scroll'; deltaX: number; deltaY: number }

interface InteractionExecution {
  result: Promise<void>
  cancel(): Promise<void>
}

interface InteractionExecutor {
  execute(input: { endpointUrl: string; pageId: string; action: NormalizedInteraction; authorization?: string }): InteractionExecution
}

interface ResolvedRuntimeAddress {
  address: string
  family: number
}

interface RuntimeOptions {
  baseUrl: string
  apiTokenProvider?: () => Promise<string>
  chromium?: ChromiumConnector
  fetchImpl?: typeof fetch
  egressProxy?: { start(): Promise<string>; close(): Promise<void> }
  interactionExecutor?: InteractionExecutor
  resolveHost?: (hostname: string) => Promise<ResolvedRuntimeAddress[]>
}

interface SnapshotRef {
  selector: string
  role: string
  name: string
}

interface ManagedConsoleEntry {
  level: number
  message: string
  sourceId: string
  line: number
  timestamp: string
}

const CONSOLE_LIMIT = 200
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024
const MAX_LIVE_VIEW_FRAME_BASE64_CHARS = 8 * 1024 * 1024
const MAX_LIVE_VIEW_FRAME_BYTES = 6 * 1024 * 1024
const MAX_SCREENSHOT_AREA = 50_000_000
const SCREENSHOT_TIMEOUT_MS = 20_000
const SENSITIVE_KEY_SUFFIX = /(?:accesstoken|refreshtoken|idtoken|token|apikey|secret|password|authorization|auth|code|session)$/i
const HIGH_RISK_ACTIVATION = /(?:\b(?:buy(?: now)?|purchase|checkout|place order|pay(?: now)?|delete|remove account|publish|post|send|transfer|withdraw|submit order|grant (?:access|permission)|allow access)\b|购买|下单|付款|支付|删除|注销|发布|发送|转账|提现|提交订单|購入|注文|支払|削除|公開|投稿|送信|振込|구매|주문|결제|삭제|게시|전송|송금)/i

function isSensitiveKey(input: string): boolean {
  return SENSITIVE_KEY_SUFFIX.test(input.replace(/[^a-z0-9]/gi, '').toLowerCase())
}

export function redactBrowserText(input: unknown, limit = 500): string {
  return String(input ?? '')
    .replace(/\bAuthorization\s*([:=])\s*Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Authorization$1 Bearer [redacted]')
    .replace(/(["']?)([A-Za-z][A-Za-z0-9_-]*(?:token|key|secret|password|authorization|auth|code|session))\1\s*([:=])\s*(["']?)([^"'\s&,;}]+)\4/gi, (_match, quote, key, separator) => isSensitiveKey(key) ? `${quote}${key}${quote}${separator}${quote}[redacted]${quote}` : _match)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\bAuthorization\s*([:=])\s*(?!Bearer\s+\[redacted\])(?:Basic\s+)?[^\s&,;]+/gi, 'Authorization$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

export function publicBrowserUrl(input: string): string {
  try {
    const parsed = new URL(input)
    parsed.username = ''
    parsed.password = ''
    for (const key of [...parsed.searchParams.keys()]) {
      if (isSensitiveKey(key)) parsed.searchParams.set(key, '[redacted]')
    }
    const hashParams = new URLSearchParams(parsed.hash.replace(/^#(?:\?)/, ''))
    if ([...hashParams.keys()].some(isSensitiveKey)) parsed.hash = '#[redacted]'
    return parsed.toString()
  } catch {
    return redactBrowserText(input, 2_048)
  }
}

export function isHighRiskBrowserActivation(role: string, label: string): boolean {
  return ['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'statictext', 'text', 'inlinetextbox', 'a'].includes(role.toLowerCase())
    && HIGH_RISK_ACTIVATION.test(label.slice(0, 160))
}

function redactConsoleText(input: unknown, limit = 2_000): string {
  return redactBrowserText(input, limit)
}

function publicConsoleSource(input: string): string {
  return publicBrowserUrl(input).slice(0, 2_048)
}

class ManagedSessionStartRollbackError extends Error {
  readonly retainRuntimeOwnerFence = true

  constructor(sessionId: string, cause: unknown) {
    super(`runtime session start failed and rollback release is unconfirmed for ${sessionId}`, { cause })
    this.name = 'ManagedSessionStartRollbackError'
  }
}

const INTERACTION_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const { chromium } = require('playwright-core')

async function findPage(browser, pageId) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const session = await context.newCDPSession(page)
      try {
        const result = await session.send('Target.getTargetInfo')
        if (String(result?.targetInfo?.targetId || '') === pageId) return page
      } finally {
        await session.detach().catch(() => undefined)
      }
    }
  }
  throw new Error('Browser tab not found')
}

async function main() {
  const browser = await chromium.connectOverCDP(workerData.endpointUrl, {
    timeout: 30_000,
    ...(workerData.authorization ? { headers: { Authorization: workerData.authorization } } : {}),
  })
  const page = await findPage(browser, workerData.pageId)
  const action = workerData.action
  if (action.kind === 'click') await page.locator(action.selector).click({ timeout: 10_000 })
  else if (action.kind === 'type') await page.locator(action.selector).fill(action.text)
  else if (action.kind === 'press') await page.keyboard.press(action.key)
  else if (action.kind === 'scroll') await page.mouse.wheel(action.deltaX, action.deltaY)
  else throw new Error('Unsupported browser interaction')
}

main().then(
  () => parentPort.postMessage({ ok: true }),
  error => parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }),
).finally(() => setImmediate(() => process.exit(0)))
`

class WorkerInteractionExecutor implements InteractionExecutor {
  execute(input: { endpointUrl: string; pageId: string; action: NormalizedInteraction; authorization?: string }): InteractionExecution {
    const worker = new Worker(INTERACTION_WORKER_SOURCE, { eval: true, workerData: input })
    let settled = false
    let cancelling = false
    let resolveResult!: () => void
    let rejectResult!: (error: Error) => void
    const result = new Promise<void>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    const settle = (error?: Error) => {
      if (settled) return
      settled = true
      if (error) rejectResult(error)
      else resolveResult()
    }
    worker.once('message', (message: { ok?: boolean; error?: string }) => {
      if (cancelling) settle(new Error('Browser interaction executor was terminated by user takeover'))
      else if (message?.ok) settle()
      else settle(new Error(message?.error || 'Browser interaction failed'))
    })
    worker.once('error', error => settle(error))
    worker.once('exit', code => {
      if (!settled) settle(new Error(cancelling ? 'Browser interaction executor was terminated by user takeover' : `Browser interaction executor exited with code ${code}`))
    })
    return {
      result,
      cancel: async () => {
        if (settled) return
        cancelling = true
        await worker.terminate()
        settle(new Error('Browser interaction executor was terminated by user takeover'))
      },
    }
  }
}

function isPrivateRuntimeAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0]
  if (normalized.startsWith('::ffff:')) return isPrivateRuntimeAddress(normalized.slice(7))
  if (isIP(normalized) === 4) {
    const parts = normalized.split('.').map(Number)
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
  }
  if (isIP(normalized) === 6) {
    if (normalized === '::1') return true
    const first = Number.parseInt(normalized.split(':')[0] || '0', 16)
    return (first & 0xfe00) === 0xfc00
  }
  return false
}

function normalizeUrl(url: string, allowBlank = false): string {
  const input = String(url || '').trim()
  if (allowBlank && (!input || input === 'about:blank')) return 'about:blank'
  const withProtocol = /^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`
  const parsed = new URL(withProtocol)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only HTTP and HTTPS browser URLs are allowed')
  if (parsed.username || parsed.password) throw new Error('URLs containing credentials are not allowed')
  return parsed.toString()
}

class ManagedHttpRuntimeSession implements BrowserRuntimeSession {
  readonly id: string
  private readonly baseUrl: URL
  private readonly runtimeHostHeader: string
  private readonly browser: Browser
  private readonly context: BrowserContext
  private readonly fetchImpl: typeof fetch
  private readonly endpointUrl: string
  private readonly authorization?: string
  private readonly interactionExecutor: InteractionExecutor
  private readonly activeInteractions = new Map<string, Set<InteractionExecution>>()
  private readonly refs = new Map<string, { snapshotId: string; items: Map<string, SnapshotRef> }>()
  private readonly pageIds = new WeakMap<Page, string>()
  private readonly pagesById = new Map<string, Page>()
  private readonly consoleByPage = new Map<string, ManagedConsoleEntry[]>()
  private released = false
  private browserClosed = false
  private releasePromise: Promise<void> | null = null
  private instrumentationFailure: Error | null = null

  constructor(options: {
    id: string
    baseUrl: URL
    runtimeHostHeader: string
    browser: Browser
    context: BrowserContext
    fetchImpl: typeof fetch
    endpointUrl: string
    authorization?: string
    interactionExecutor: InteractionExecutor
  }) {
    this.id = options.id
    this.baseUrl = options.baseUrl
    this.runtimeHostHeader = options.runtimeHostHeader
    this.browser = options.browser
    this.context = options.context
    this.fetchImpl = options.fetchImpl
    this.endpointUrl = options.endpointUrl
    this.authorization = options.authorization
    this.interactionExecutor = options.interactionExecutor
  }

  async initialize(): Promise<void> {
    for (const page of this.context.pages()) await this.trackPage(page)
    this.context.on?.('page', page => {
      void this.trackPage(page).catch(error => {
        if (page.isClosed() || this.isTargetCloseError(error)) return
        this.instrumentationFailure = error instanceof Error ? error : new Error(String(error))
      })
    })
  }

  async listPages(): Promise<BrowserPageState[]> {
    this.assertInstrumentationHealthy()
    const pages = this.context.pages().filter(page => !page.isClosed())
    const result: BrowserPageState[] = []
    for (const page of pages) {
      const id = await this.trackPage(page)
      result.push(await this.pageState(page, id))
    }
    return result
  }

  async createPage(url: string): Promise<BrowserPageState> {
    const normalized = normalizeUrl(url, true)
    const page = await this.context.newPage()
    const id = await this.trackPage(page)
    if (normalized !== 'about:blank') await page.goto(normalized, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    return await this.pageState(page, id)
  }

  async closePage(pageId: string): Promise<void> {
    const page = this.requirePage(pageId)
    await page.close()
    this.pagesById.delete(pageId)
    this.refs.delete(pageId)
    this.consoleByPage.delete(pageId)
  }

  async activatePage(pageId: string): Promise<void> {
    await this.requirePage(pageId).bringToFront()
  }

  async navigate(pageId: string, url: string): Promise<BrowserPageState> {
    const page = this.requirePage(pageId)
    await page.goto(normalizeUrl(url), { waitUntil: 'domcontentloaded', timeout: 30_000 })
    this.refs.delete(pageId)
    return await this.pageState(page, pageId)
  }

  async navigationAction(pageId: string, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<BrowserPageState> {
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
      const input = element as HTMLInputElement
      const inputType = String(input.type || '').toLowerCase()
      const isStructurallyVisible = (candidate: Element): boolean => {
        if (candidate.closest?.('[hidden],[aria-hidden="true"],[inert],template')) return false
        const viewportWidth = Number(globalThis.innerWidth) || 0
        const viewportHeight = Number(globalThis.innerHeight) || 0
        const rects = candidate.getClientRects?.()
        const rect = candidate.getBoundingClientRect?.()
        if (!rects?.length || !rect || rect.width <= 0 || rect.height <= 0) return false
        let left = Math.max(0, rect.left)
        let top = Math.max(0, rect.top)
        let right = viewportWidth > 0 ? Math.min(viewportWidth, rect.right) : rect.right
        let bottom = viewportHeight > 0 ? Math.min(viewportHeight, rect.bottom) : rect.bottom
        for (let current: Element | null = candidate; current; current = current.parentElement) {
          const currentStyle = globalThis.getComputedStyle?.(current)
          if (currentStyle && (currentStyle.display === 'none' || currentStyle.visibility === 'hidden' || currentStyle.visibility === 'collapse' || Number(currentStyle.opacity) === 0)) return false
          const clipPath = String(currentStyle?.clipPath || currentStyle?.getPropertyValue?.('clip-path') || 'none')
          if (clipPath !== 'none') return false
          if (current !== candidate && currentStyle) {
            const overflowX = String(currentStyle.overflowX || currentStyle.overflow)
            const overflowY = String(currentStyle.overflowY || currentStyle.overflow)
            if (/(?:hidden|clip|scroll|auto)/.test(overflowX) || /(?:hidden|clip|scroll|auto)/.test(overflowY)) {
              const ancestorRect = current.getBoundingClientRect?.()
              if (!ancestorRect) return false
              if (/(?:hidden|clip|scroll|auto)/.test(overflowX)) {
                left = Math.max(left, ancestorRect.left)
                right = Math.min(right, ancestorRect.right)
              }
              if (/(?:hidden|clip|scroll|auto)/.test(overflowY)) {
                top = Math.max(top, ancestorRect.top)
                bottom = Math.min(bottom, ancestorRect.bottom)
              }
            }
          }
        }
        return right > left && bottom > top
      }
      if (!isStructurallyVisible(element)) return null
      if (element.tagName.toLowerCase() === 'input' && inputType === 'hidden') return null
      const projectedText = (node: Node): string => {
        if (node.nodeType === 3) return node.textContent || ''
        if (node.nodeType !== 1 || !isStructurallyVisible(node as Element)) return ''
        return Array.from(node.childNodes || []).map(projectedText).join('')
      }
      const inputButton = element.tagName.toLowerCase() === 'input' && ['submit', 'button', 'reset', 'image'].includes(inputType)
      const role = element.getAttribute('role') || (inputButton ? 'button' : element.tagName.toLowerCase())
      const protectedValue = element.tagName.toLowerCase() === 'input' && ['password', 'hidden'].includes(inputType)
      // Form values are data, not accessible names. Button-like input values are
      // the visible activation label and must be retained for high-risk checks.
      const name = protectedValue ? '' : element.getAttribute('aria-label') || element.getAttribute('title') || (inputButton ? input.value : '') || (html.childNodes ? Array.from(html.childNodes).map(projectedText).join('').trim() : (html.innerText || '').trim()) || ''
      return { ref: `@e${index + 1}`, role, name: name.slice(0, 500), selector: `[data-hermes-browser-ref="${index + 1}"]` }
    })).then(items => items.filter((item): item is NonNullable<typeof item> => item !== null))
    await page.locator('a,button,input,textarea,select,[role],[tabindex]').evaluateAll((elements: Element[]) => {
      elements.slice(0, 500).forEach((element, index) => element.setAttribute('data-hermes-browser-ref', String(index + 1)))
    })
    const publicNodes = nodes.map(node => ({ ...node, name: redactBrowserText(node.name) }))
    this.refs.set(pageId, { snapshotId, items: new Map(publicNodes.map(node => [node.ref, { selector: node.selector, role: node.role, name: node.name }])) })
    const text = publicNodes.map(node => `${node.ref} ${node.role} name=${JSON.stringify(node.name)}`).join('\n')
    return { tabId: pageId, snapshotId, url: publicBrowserUrl(page.url()), title: redactBrowserText(await page.title()), nodes: publicNodes.map(({ selector: _selector, ...node }) => node), text }
  }

  async readText(pageId: string, input: Record<string, unknown>): Promise<unknown> {
    const page = this.requirePage(pageId)
    const ref = String(input.ref || '')
    const snapshotId = String(input.snapshotId || input.snapshot_id || '')
    const snapshot = this.refs.get(pageId)
    if (!snapshotId || snapshot?.snapshotId !== snapshotId) throw new Error('Browser snapshot reference is stale or invalid')
    const item = snapshot.items.get(ref)
    if (!item) throw new Error('Browser snapshot reference is stale or invalid')
    const mode = input.mode === 'textContent' ? 'textContent' : 'innerText'
    const source = await page.locator(item.selector).evaluate((element: Element) => {
      const html = element as HTMLElement
      const input = element as HTMLInputElement
      const inputType = String(input.type || '').toLowerCase()
      const viewportWidth = Number(globalThis.innerWidth) || 0
      const viewportHeight = Number(globalThis.innerHeight) || 0
      const isVisible = (candidate: Element): boolean => {
        if (candidate.closest?.('[hidden],[aria-hidden="true"],[inert],template')) return false
        const rects = candidate.getClientRects?.()
        const rect = candidate.getBoundingClientRect?.()
        if (!rects?.length || !rect || rect.width <= 0 || rect.height <= 0) return false
        let left = Math.max(0, rect.left)
        let top = Math.max(0, rect.top)
        let right = viewportWidth > 0 ? Math.min(viewportWidth, rect.right) : rect.right
        let bottom = viewportHeight > 0 ? Math.min(viewportHeight, rect.bottom) : rect.bottom
        for (let current: Element | null = candidate; current; current = current.parentElement) {
          const style = globalThis.getComputedStyle?.(current)
          if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0)) return false
          const clipPath = String(style?.clipPath || style?.getPropertyValue?.('clip-path') || 'none')
          if (clipPath !== 'none') return false
          if (current !== candidate && style) {
            const overflowX = String(style.overflowX || style.overflow)
            const overflowY = String(style.overflowY || style.overflow)
            if (/(?:hidden|clip|scroll|auto)/.test(overflowX) || /(?:hidden|clip|scroll|auto)/.test(overflowY)) {
              const ancestorRect = current.getBoundingClientRect?.()
              if (!ancestorRect) return false
              if (/(?:hidden|clip|scroll|auto)/.test(overflowX)) {
                left = Math.max(left, ancestorRect.left)
                right = Math.min(right, ancestorRect.right)
              }
              if (/(?:hidden|clip|scroll|auto)/.test(overflowY)) {
                top = Math.max(top, ancestorRect.top)
                bottom = Math.min(bottom, ancestorRect.bottom)
              }
            }
          }
        }
        return right > left && bottom > top
      }
      if (!isVisible(element)) throw new Error('Browser snapshot reference is no longer visible')
      if (element.tagName.toLowerCase() === 'input' && ['password', 'hidden'].includes(inputType)) return ''
      const visibleText = (node: Node): string => {
        if (node.nodeType === 3) return node.textContent || ''
        if (node.nodeType !== 1 || !isVisible(node as Element)) return ''
        return Array.from(node.childNodes).map(visibleText).join('')
      }
      // Never return the raw DOM textContent/innerText. Re-project every descendant
      // through the same structural visibility boundary as the snapshot.
      return Array.from(html.childNodes).map(visibleText).join('')
    })
    const offset = Math.max(0, Number(input.offset) || 0)
    const limit = Math.max(1, Math.min(20_000, Number(input.limit) || 4_000))
    const text = redactBrowserText(source.slice(offset, offset + limit), limit)
    return { tabId: pageId, snapshotId, ref, mode, offset, limit, text, totalLength: source.length, returnedLength: text.length, hasMore: offset + text.length < source.length, ...(offset + text.length < source.length ? { nextOffset: offset + text.length } : {}) }
  }

  async interact(pageId: string, action: Record<string, unknown>): Promise<BrowserPageState> {
    const page = this.requirePage(pageId)
    const kind = String(action.action || '')
    let normalized: NormalizedInteraction
    if (kind === 'click' || kind === 'type') {
      const ref = String(action.ref || '')
      const snapshotId = String(action.snapshotId || action.snapshot_id || '')
      const snapshot = this.refs.get(pageId)
      if (!snapshotId || snapshot?.snapshotId !== snapshotId) throw new Error('Browser snapshot reference is stale or invalid')
      const item = snapshot.items.get(ref)
      if (!item) throw new Error('Browser snapshot reference is stale or invalid')
      if (kind === 'click' && isHighRiskBrowserActivation(item.role, item.name)) {
        throw new Error('High-risk browser activation is not supported by the managed runtime provider without an interactive user confirmation channel')
      }
      normalized = kind === 'click'
        ? { kind, selector: item.selector }
        : { kind, selector: item.selector, text: String(action.text || '') }
    } else if (kind === 'press') {
      const key = String(action.key || '').trim()
      if (/^(?:Enter|NumpadEnter|Space| )$/i.test(key) || /(?:^|\+)(?:Enter|NumpadEnter|Space)$/i.test(key)) {
        throw new Error('High-risk browser key activation is not supported by the managed runtime provider without an interactive user confirmation channel')
      }
      normalized = { kind, key }
    } else if (kind === 'scroll') {
      const pixels = Math.max(1, Math.min(10_000, Number(action.pixels) || 600))
      const direction = String(action.direction || 'down')
      normalized = {
        kind,
        deltaX: direction === 'left' ? -pixels : direction === 'right' ? pixels : 0,
        deltaY: direction === 'up' ? -pixels : direction === 'down' ? pixels : 0,
      }
    } else {
      throw new Error('Unsupported browser interaction')
    }
    const execution = this.interactionExecutor.execute({ endpointUrl: this.endpointUrl, pageId, action: normalized, authorization: this.authorization })
    const active = this.activeInteractions.get(pageId) || new Set<InteractionExecution>()
    active.add(execution)
    this.activeInteractions.set(pageId, active)
    try {
      await execution.result
    } finally {
      active.delete(execution)
      if (!active.size) this.activeInteractions.delete(pageId)
    }
    this.refs.delete(pageId)
    return await this.pageState(page, pageId)
  }

  async screenshot(pageId: string, fullPage: boolean): Promise<unknown> {
    const page = this.requirePage(pageId)
    const viewport = page.viewportSize() || { width: 0, height: 0 }
    let dimensions = viewport
    if (fullPage) {
      dimensions = await page.evaluate(() => ({
        width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
        height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
      }))
      if (dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width * dimensions.height > MAX_SCREENSHOT_AREA) {
        throw new Error('Browser screenshot dimensions exceed the safe limit')
      }
    }
    const data = await page.screenshot({
      type: 'png',
      fullPage: false,
      timeout: SCREENSHOT_TIMEOUT_MS,
      ...(fullPage ? { clip: { x: 0, y: 0, width: dimensions.width, height: dimensions.height } } : {}),
    })
    if (data.byteLength > MAX_SCREENSHOT_BYTES) throw new Error('Browser screenshot exceeds the safe byte limit')
    return { tabId: pageId, url: publicBrowserUrl(page.url()), title: redactBrowserText(await page.title()), mediaType: 'image/png', data: Buffer.from(data).toString('base64'), width: dimensions.width, height: dimensions.height }
  }

  async consoleEntries(pageId: string): Promise<unknown[]> {
    this.requirePage(pageId)
    return (this.consoleByPage.get(pageId) || []).map(entry => ({ ...entry }))
  }

  async clearConsole(pageId: string): Promise<void> {
    this.requirePage(pageId)
    this.consoleByPage.set(pageId, [])
  }

  async cancelAgentOperation(pageId: string): Promise<void> {
    const page = this.requirePage(pageId)
    const active = [...(this.activeInteractions.get(pageId) || [])]
    await Promise.all(active.map(execution => execution.cancel()))
    const session = await this.context.newCDPSession(page)
    await session.send('Page.stopLoading').finally(() => session.detach())
    this.refs.delete(pageId)
  }

  async openLiveView(
    pageId: string,
    onFrame: (frame: { data: string; metadata?: Record<string, unknown> }) => void,
  ): Promise<{ dispatch(input: unknown): Promise<void>; close(): Promise<void> }> {
    const page = this.requirePage(pageId)
    const session = await this.context.newCDPSession(page)
    const cdp = session as CDPSession & {
      on(event: string, listener: (event: any) => void): unknown
      off?(event: string, listener: (event: any) => void): unknown
    }
    let closed = false
    const frameListener = (event: { data?: string; sessionId?: number; metadata?: Record<string, unknown> }) => {
      if (closed || typeof event?.data !== 'string' || !event.data) return
      if (typeof event.sessionId === 'number') {
        void session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined)
      }
      if (event.data.length > MAX_LIVE_VIEW_FRAME_BASE64_CHARS || Buffer.byteLength(event.data, 'base64') > MAX_LIVE_VIEW_FRAME_BYTES) return
      try {
        onFrame({ data: event.data, ...(event.metadata ? { metadata: event.metadata } : {}) })
      } catch {
        // The CDP stream must stay acked even if a downstream viewer disappears mid-frame.
      }
    }
    cdp.on('Page.screencastFrame', frameListener)
    try {
      await session.send('Page.enable')
      await session.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 70,
        maxWidth: 1280,
        maxHeight: 720,
        everyNthFrame: 1,
      })
    } catch (error) {
      cdp.off?.('Page.screencastFrame', frameListener)
      await session.detach().catch(() => undefined)
      throw error
    }
    return {
      dispatch: async input => {
        if (closed) throw new Error('Browser live view is closed')
        const message = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, any> : {}
        const event = message.event && typeof message.event === 'object' && !Array.isArray(message.event) ? message.event as Record<string, any> : {}
        if (message.type === 'mouseEvent') {
          const type = String(event.type || '') as 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel'
          if (!['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'].includes(type)) throw new Error('Invalid browser mouse event')
          const button = (['none', 'left', 'middle', 'right', 'back', 'forward'].includes(String(event.button)) ? String(event.button) : 'none') as 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward'
          const x = Number(event.x)
          const y = Number(event.y)
          if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 100_000 || y > 100_000) throw new Error('Invalid browser mouse coordinates')
          const deltaX = event.deltaX == null ? 0 : Number(event.deltaX)
          const deltaY = event.deltaY == null ? 0 : Number(event.deltaY)
          if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || Math.abs(deltaX) > 100_000 || Math.abs(deltaY) > 100_000) throw new Error('Invalid browser mouse delta')
          await session.send('Input.dispatchMouseEvent', {
            type,
            x,
            y,
            button,
            clickCount: Math.max(0, Math.min(3, Number(event.clickCount) || 0)),
            deltaX,
            deltaY,
          })
          return
        }
        if (message.type === 'keyEvent') {
          const type = String(event.type || '') as 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char'
          if (!['keyDown', 'keyUp', 'rawKeyDown', 'char'].includes(type)) throw new Error('Invalid browser key event')
          const text = typeof event.text === 'string' ? event.text : ''
          if (text.length > 10_000) throw new Error('Browser live-view text is too large')
          if ((type === 'keyDown' || type === 'char') && text) {
            await session.send('Input.insertText', { text })
            return
          }
          const key = String(event.key || '')
          const code = String(event.code || '')
          const keyCode = Number(event.keyCode || 0)
          if (key.length > 256 || code.length > 256 || !Number.isFinite(keyCode) || keyCode < 0 || keyCode > 0xffff) throw new Error('Invalid browser key event')
          await session.send('Input.dispatchKeyEvent', {
            type,
            key,
            code,
            windowsVirtualKeyCode: keyCode,
          })
          return
        }
        if (message.type === 'insertText' && typeof message.text === 'string') {
          if (message.text.length > 10_000) throw new Error('Browser live-view text is too large')
          await session.send('Input.insertText', { text: message.text })
          return
        }
        throw new Error('Unsupported browser live-view input')
      },
      close: async () => {
        if (closed) return
        closed = true
        cdp.off?.('Page.screencastFrame', frameListener)
        await session.send('Page.stopScreencast').catch(() => undefined)
        await session.detach().catch(() => undefined)
      },
    }
  }

  async release(): Promise<void> {
    if (this.released) return
    if (this.releasePromise) return await this.releasePromise
    const release = (async () => {
      const response = await this.fetchImpl(new URL(`/v1/sessions/${encodeURIComponent(this.id)}/release`, this.baseUrl), {
        method: 'POST',
        headers: {
          ...(this.authorization ? { Authorization: this.authorization } : {}),
          Host: this.runtimeHostHeader,
        },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`runtime session release failed with HTTP ${response.status}`)
      this.released = true
      if (!this.browserClosed) {
        try { await this.browser.close() } catch { /* exact Runtime release already succeeded */ }
        this.browserClosed = true
      }
    })()
    this.releasePromise = release
    try {
      await release
    } finally {
      if (this.releasePromise === release) this.releasePromise = null
    }
  }

  private assertInstrumentationHealthy(): void {
    if (this.instrumentationFailure) throw new Error('Managed page instrumentation failed', { cause: this.instrumentationFailure })
  }

  private isTargetCloseError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return /target|page|session/i.test(message) && /closed|detached|destroyed/i.test(message)
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
    this.consoleByPage.set(id, [])
    const eventPage = page as Page & {
      on?: (event: string, listener: (...args: any[]) => void) => unknown
      once?: (event: string, listener: (...args: any[]) => void) => unknown
    }
    if (typeof eventPage.on === 'function') eventPage.on('console', message => {
      const location = message.location()
      const entries = this.consoleByPage.get(id) || []
      const level = ({ debug: 0, info: 1, log: 1, warning: 2, warn: 2, error: 3 } as Record<string, number>)[message.type()] ?? 1
      entries.push({
        level,
        message: redactConsoleText(message.text()),
        sourceId: publicConsoleSource(String(location.url || '')),
        line: Math.max(0, Number(location.lineNumber) || 0),
        timestamp: new Date().toISOString(),
      })
      if (entries.length > CONSOLE_LIMIT) entries.splice(0, entries.length - CONSOLE_LIMIT)
      this.consoleByPage.set(id, entries)
    })
    if (typeof eventPage.on === 'function') eventPage.on('pageerror', error => {
      const entries = this.consoleByPage.get(id) || []
      entries.push({ level: 3, message: redactConsoleText(error.message), sourceId: '', line: 0, timestamp: new Date().toISOString() })
      if (entries.length > CONSOLE_LIMIT) entries.splice(0, entries.length - CONSOLE_LIMIT)
      this.consoleByPage.set(id, entries)
    })
    if (typeof eventPage.once === 'function') eventPage.once('close', () => {
      this.pagesById.delete(id)
      this.refs.delete(id)
      this.consoleByPage.delete(id)
    })
    return id
  }

  private async pageState(page: Page, id: string): Promise<BrowserPageState> {
    const session = await this.context.newCDPSession(page)
    let canGoBack = false
    let canGoForward = false
    try {
      const history = await session.send('Page.getNavigationHistory') as { currentIndex?: number; entries?: unknown[] }
      const currentIndex = Number(history.currentIndex)
      const entries = Array.isArray(history.entries) ? history.entries : []
      canGoBack = Number.isInteger(currentIndex) && currentIndex > 0
      canGoForward = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < entries.length - 1
    } finally {
      await session.detach()
    }
    const loading = typeof (page as Page & { evaluate?: unknown }).evaluate === 'function'
      ? await page.evaluate(() => document.readyState !== 'complete').catch(() => false)
      : false
    return {
      id,
      title: redactBrowserText(await page.title().catch(() => '')),
      url: publicBrowserUrl(page.url()),
      loading,
      canGoBack,
      canGoForward,
      crashed: page.isClosed(),
    }
  }
}

export class HttpBrowserRuntimeAdapter implements BrowserRuntimeAdapter {
  private readonly baseUrl: URL
  private readonly chromium: ChromiumConnector
  private readonly fetchImpl: typeof fetch
  private readonly apiTokenProvider?: () => Promise<string>
  private readonly egressProxy?: { start(): Promise<string>; close(): Promise<void> }
  private readonly interactionExecutor: InteractionExecutor
  private readonly resolveHost: (hostname: string) => Promise<ResolvedRuntimeAddress[]>
  private pinnedBaseUrl: Promise<URL> | null = null
  private readonly runtimeHostHeader: string
  private pendingRollback: { ownerKey: string; sessionId: string; authorization?: string; startError: unknown } | null = null

  constructor(options: RuntimeOptions) {
    this.baseUrl = new URL(options.baseUrl)
    this.chromium = options.chromium || chromium
    this.fetchImpl = options.fetchImpl || fetch
    this.apiTokenProvider = options.apiTokenProvider
    this.egressProxy = options.egressProxy
    this.interactionExecutor = options.interactionExecutor || new WorkerInteractionExecutor()
    this.resolveHost = options.resolveHost || (async hostname => await lookup(hostname, { all: true, verbatim: true }))
    this.runtimeHostHeader = this.baseUrl.host
  }

  async startSession(input: { ownerKey: string; profile: string }): Promise<BrowserRuntimeSession> {
    const pinnedBaseUrl = await this.getPinnedBaseUrl()
    await this.recoverPendingRollback(input.ownerKey)
    const requestedId = randomUUID()
    const egressProxyUrl = await this.egressProxy?.start()
    const token = await this.apiTokenProvider?.()
    if (this.apiTokenProvider && (!token || token.length < 32)) throw new Error('Managed Browser service authentication is unavailable')
    const authorization = token ? `Bearer ${token}` : undefined
    const response = await this.fetchImpl(new URL('/v1/sessions', pinnedBaseUrl), {
      method: 'POST',
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        'Content-Type': 'application/json',
        Host: this.runtimeHostHeader,
      },
      body: JSON.stringify({
        sessionId: requestedId,
        ...(egressProxyUrl ? { proxyUrl: egressProxyUrl } : {}),
      }),
      signal: AbortSignal.timeout(45_000),
    })
    const payload = await response.json().catch(() => null) as { id?: string; websocketUrl?: string } | null
    if (!response.ok || !payload?.id || !payload.websocketUrl) throw new Error(`Managed Browser session failed with HTTP ${response.status}`)
    let browser: Browser | null = null
    try {
      const endpoint = this.privateWebSocketEndpoint(payload.websocketUrl, 'CDP', pinnedBaseUrl)
      browser = await this.chromium.connectOverCDP(endpoint.toString(), {
        timeout: 30_000,
        ...(authorization ? { headers: { Authorization: authorization } } : {}),
      })
      const context = browser.contexts()[0]
      if (!context) throw new Error('Managed Browser did not expose a browser context')
      const session = new ManagedHttpRuntimeSession({
        id: payload.id,
        baseUrl: pinnedBaseUrl,
        runtimeHostHeader: this.runtimeHostHeader,
        browser,
        context,
        fetchImpl: this.fetchImpl,
        endpointUrl: endpoint.toString(),
        authorization,
        interactionExecutor: this.interactionExecutor,
      })
      await session.initialize()
      return session
    } catch (error) {
      await browser?.close().catch(() => undefined)
      try {
        await this.releaseRemoteSession(payload.id, authorization)
      } catch (releaseError) {
        this.pendingRollback = { ownerKey: input.ownerKey, sessionId: payload.id, authorization, startError: error }
        throw new ManagedSessionStartRollbackError(payload.id, new AggregateError([error, releaseError], 'runtime session initialization and rollback both failed'))
      }
      throw new Error('Managed Browser runtime connection failed', { cause: error })
    }
  }

  async shutdown(): Promise<void> {
    if (this.pendingRollback) await this.recoverPendingRollback(this.pendingRollback.ownerKey)
    await this.egressProxy?.close()
  }

  private async getPinnedBaseUrl(): Promise<URL> {
    this.pinnedBaseUrl ||= this.resolvePinnedBaseUrl()
    return await this.pinnedBaseUrl
  }

  private async resolvePinnedBaseUrl(): Promise<URL> {
    const configuredHost = this.baseUrl.hostname.toLowerCase()
    const directFamily = isIP(configuredHost)
    const addresses = directFamily
      ? [{ address: configuredHost, family: directFamily }]
      : await this.resolveHost(configuredHost)
    if (!addresses.length || addresses.some(item => !isPrivateRuntimeAddress(item.address))) {
      throw new Error('Managed Browser runtime must resolve only to private addresses')
    }
    const pinned = addresses.find(item => item.family === 4 && isIP(item.address) === 4)
    if (!pinned) throw new Error('Managed Browser runtime must expose a private IPv4 address')
    const url = new URL(this.baseUrl)
    url.hostname = pinned.address
    return url
  }

  private privateWebSocketEndpoint(raw: string, label: string, pinnedBaseUrl: URL): URL {
    const endpoint = new URL(raw)
    if ((endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') || endpoint.username || endpoint.password) {
      throw new Error(`Managed Browser returned an invalid ${label} endpoint`)
    }
    const advertisedHost = endpoint.hostname.toLowerCase()
    const configuredHost = this.baseUrl.hostname.toLowerCase()
    if (advertisedHost !== configuredHost && advertisedHost !== '0.0.0.0' && advertisedHost !== '::' && advertisedHost !== 'localhost' && !isIP(advertisedHost)) {
      throw new Error(`Managed Browser returned an untrusted ${label} endpoint`)
    }
    endpoint.protocol = pinnedBaseUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    endpoint.host = pinnedBaseUrl.host
    return endpoint
  }

  private async recoverPendingRollback(ownerKey: string): Promise<void> {
    const pending = this.pendingRollback
    if (!pending) return
    if (pending.ownerKey !== ownerKey) throw new Error('Managed Browser runtime is already assigned to another authenticated user')
    try {
      await this.releaseRemoteSession(pending.sessionId, pending.authorization)
      if (this.pendingRollback === pending) this.pendingRollback = null
    } catch (releaseError) {
      throw new ManagedSessionStartRollbackError(pending.sessionId, new AggregateError([pending.startError, releaseError], 'runtime session rollback remains unconfirmed'))
    }
  }

  private async releaseRemoteSession(sessionId: string, authorization?: string): Promise<void> {
    const pinnedBaseUrl = await this.getPinnedBaseUrl()
    const response = await this.fetchImpl(new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/release`, pinnedBaseUrl), {
      method: 'POST',
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        Host: this.runtimeHostHeader,
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`runtime session release failed with HTTP ${response.status}`)
  }
}
