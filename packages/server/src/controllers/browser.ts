import { randomUUID } from 'node:crypto'
import Router from '@koa/router'
import type { Context } from 'koa'
import type { ManagedBrowserService, BrowserOwner } from '../services/browser/managed-browser-service'
import type { BrowserProviderRegistry } from '../services/browser/provider-registry'
import { mapContainedViewPoint } from '../services/browser/live-view-geometry'

function owner(ctx: Context): BrowserOwner | null {
  const userId = Number(ctx.state.user?.id)
  if (!Number.isInteger(userId) || userId <= 0) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return null
  }
  const profile = String(ctx.state.profile?.name || '').trim()
  if (!profile) {
    ctx.status = 400
    ctx.body = { error: 'Profile is required' }
    return null
  }
  return { userId, profile }
}

function body(ctx: Context): Record<string, unknown> {
  const value = ctx.request.body
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function requiredParam(ctx: Context, name: string): string {
  const value = String(ctx.params[name] || '').trim()
  if (!value || value.length > 4096) throw new Error(`${name} is required`)
  return value
}

function browserControlStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error)
  if (/tab not found|view not found/i.test(message)) return 404
  if (/operation identity|instance changed|invalid response/i.test(message)) return 502
  if (/not registered|unknown browser method|required|invalid/i.test(message)) return 400
  if (/not available|no browser provider|not configured/i.test(message)) return 503
  if (/assigned|selected browser provider|takeover|release|releasing|deactivat|session not found|high-risk|stale/i.test(message)) return 409
  return 500
}

async function browserControl<T>(ctx: Context, operation: () => Promise<T>): Promise<T | undefined> {
  try {
    return await operation()
  } catch (error) {
    ctx.status = browserControlStatus(error)
    ctx.body = { error: error instanceof Error ? error.message : String(error) }
    return undefined
  }
}

export function viewerDocument(socketPath: string): string {
  const encodedPath = JSON.stringify(socketPath)
  const mapPointSource = mapContainedViewPoint.toString()
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hermes Browser</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fff}canvas{display:block;width:100%;height:100%;object-fit:contain;outline:none}</style></head><body><canvas tabindex="0" aria-label="Browser page"></canvas><script>(()=>{const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');let width=1280,height=720,targetWidth=1280,targetHeight=720,pendingFrame=null,decoding=false,pendingMove=null,moveScheduled=false,pressedButton=null,pressedPoint=null,pressedClickCount=1;const mapContainedViewPoint=${mapPointSource};const scheme=location.protocol==='https:'?'wss:':'ws:';const ws=new WebSocket(scheme+'//'+location.host+${encodedPath});ws.binaryType='arraybuffer';function coords(event){const r=canvas.getBoundingClientRect();return mapContainedViewPoint({clientX:event.clientX,clientY:event.clientY,rectLeft:r.left,rectTop:r.top,rectWidth:r.width,rectHeight:r.height,bitmapWidth:width,bitmapHeight:height,targetWidth,targetHeight})}function send(value){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(value))}function positiveDimension(value,fallback){const number=Number(value);return Number.isFinite(number)&&number>0?number:fallback}function releasePressed(){if(!pressedButton||!pressedPoint)return;const button=pressedButton,point=pressedPoint,clickCount=pressedClickCount;pressedButton=null;pressedPoint=null;pendingMove=null;send({type:'mouseEvent',event:{type:'mouseReleased',...point,button,clickCount}})}function decodeLatest(){if(decoding||!pendingFrame)return;const frame=pendingFrame;pendingFrame=null;decoding=true;const image=new Image();const done=()=>{decoding=false;if(pendingFrame)decodeLatest()};image.onload=()=>{width=image.naturalWidth||width;height=image.naturalHeight||height;const metadata=frame.metadata||{};targetWidth=positiveDimension(metadata.deviceWidth,width);targetHeight=positiveDimension(metadata.deviceHeight,height);canvas.width=width;canvas.height=height;ctx.drawImage(image,0,0);done()};image.onerror=done;image.src='data:image/jpeg;base64,'+frame.data}ws.onmessage=event=>{const text=typeof event.data==='string'?event.data:new TextDecoder().decode(event.data);const frame=JSON.parse(text);if(frame.data){pendingFrame=frame;decodeLatest()}};canvas.addEventListener('mousedown',event=>{canvas.focus();const p=coords(event);if(!p)return;pressedButton=['left','middle','right'][event.button]||'left';pressedPoint=p;pressedClickCount=event.detail||1;send({type:'mouseEvent',event:{type:'mousePressed',...p,button:pressedButton,clickCount:pressedClickCount}})});canvas.addEventListener('mouseup',event=>{if(!pressedButton)return;const p=coords(event);if(p)pressedPoint=p;releasePressed()});canvas.addEventListener('mousemove',event=>{const p=coords(event);if(pressedButton&&p)pressedPoint=p;pendingMove=p;if(moveScheduled)return;moveScheduled=true;requestAnimationFrame(()=>{moveScheduled=false;const point=pendingMove;pendingMove=null;if(!point)return;send({type:'mouseEvent',event:{type:'mouseMoved',...point,button:'none'}})})});window.addEventListener('mouseup',releasePressed,true);window.addEventListener('blur',releasePressed);window.addEventListener('pagehide',releasePressed);document.addEventListener('visibilitychange',()=>{if(document.hidden)releasePressed()});try{if(parent!==window)parent.addEventListener('mouseup',releasePressed,true)}catch{};canvas.addEventListener('wheel',event=>{event.preventDefault();const p=coords(event);if(!p)return;send({type:'mouseEvent',event:{type:'mouseWheel',...p,button:'none',deltaX:event.deltaX,deltaY:event.deltaY}})},{passive:false});canvas.addEventListener('keydown',event=>{event.preventDefault();send({type:'keyEvent',event:{type:'keyDown',key:event.key,code:event.code,keyCode:event.keyCode,text:event.key.length===1?event.key:''}});send({type:'keyEvent',event:{type:'keyUp',key:event.key,code:event.code,keyCode:event.keyCode,text:''}})})})()</script></body></html>`
}

export function createBrowserController(service: ManagedBrowserService, registry?: BrowserProviderRegistry) {
  const withManagedOwner = async <T>(ctx: Context, operation: (owner: BrowserOwner) => Promise<T>): Promise<T | undefined> => {
    const current = owner(ctx)
    if (!current) return undefined
    return await browserControl(ctx, () => registry
      ? registry.withSelectedProvider(current, 'managed-runtime', () => operation(current))
      : operation(current))
  }

  return {
    async providers(ctx: Context) {
      const current = owner(ctx); if (!current) return
      if (!registry) {
        ctx.body = { providers: [{ id: 'managed-runtime', kind: 'remote', label: 'Managed', available: service.configured(), selected: true }] }
        return
      }
      const result = await browserControl(ctx, () => registry.list(current))
      if (result) ctx.body = { providers: result }
    },
    async selectProvider(ctx: Context) {
      const current = owner(ctx); if (!current) return
      if (!registry) throw new Error('Browser provider selection is not configured')
      const selected = await browserControl(ctx, () => registry.select(current, requiredParam(ctx, 'providerId')))
      if (selected) ctx.body = { selected_provider_id: selected.id }
    },
    async transitionProfile(ctx: Context) {
      const current = owner(ctx); if (!current) return
      if (!registry) throw new Error('Browser provider selection is not configured')
      const previousProfile = String(body(ctx).previous_profile || '').trim()
      if (!previousProfile || previousProfile.length > 200) { ctx.status = 400; ctx.body = { error: 'previous_profile is required' }; return }
      if (previousProfile !== current.profile) {
        const result = await browserControl(ctx, async () => {
          await registry.deactivateOwner({ userId: current.userId, profile: previousProfile })
          return true
        })
        if (!result) return
      }
      ctx.body = { ok: true, profile: current.profile }
    },
    async state(ctx: Context) {
      const result = await withManagedOwner(ctx, current => service.state(current)); if (result) ctx.body = result
    },
    async createTab(ctx: Context) {
      const input = body(ctx)
      const result = await withManagedOwner(ctx, current => service.userCreateTab(current, String(input.url || 'about:blank'), input.activate !== false)); if (result) ctx.body = result
    },
    async closeTab(ctx: Context) {
      const result = await withManagedOwner(ctx, current => service.userCloseTab(current, requiredParam(ctx, 'tabId'))); if (result) ctx.body = result
    },
    async activateTab(ctx: Context) {
      const result = await withManagedOwner(ctx, current => service.userActivateTab(current, requiredParam(ctx, 'tabId'))); if (result) ctx.body = result
    },
    async navigate(ctx: Context) {
      const result = await withManagedOwner(ctx, current => service.userNavigate(current, requiredParam(ctx, 'tabId'), String(body(ctx).url || ''))); if (result) ctx.body = result
    },
    async navigationAction(ctx: Context) {
      const action = String(body(ctx).action || '')
      if (action !== 'back' && action !== 'forward' && action !== 'reload' && action !== 'stop') {
        ctx.status = 400; ctx.body = { error: 'Invalid browser navigation action' }; return
      }
      const result = await withManagedOwner(ctx, current => service.userNavigationAction(current, requiredParam(ctx, 'tabId'), action)); if (result) ctx.body = result
    },
    async viewport(ctx: Context) {
      const result = await withManagedOwner(ctx, current => service.setViewport(current, body(ctx).visible === true)); if (result) ctx.body = result
    },
    async takeOver(ctx: Context) {
      const result = await withManagedOwner(ctx, current => service.takeOver(current, requiredParam(ctx, 'tabId'))); if (result) ctx.body = result
    },
    async issueView(ctx: Context) {
      const grant = await withManagedOwner(ctx, current => service.issueView(current, requiredParam(ctx, 'tabId')))
      if (!grant) return
      ctx.set('Cache-Control', 'no-store')
      ctx.body = { url: grant.url }
    },
    async deactivate(ctx: Context) {
      const current = owner(ctx); if (!current) return
      const result = await browserControl(ctx, async () => {
        if (registry) await registry.deactivateOwner(current)
        else await service.deactivate(current)
        return true
      })
      if (result) ctx.body = { ok: true }
    },
    async viewDocument(ctx: Context) {
      let view: { socketPath: string }
      try {
        view = service.consumeViewBootstrap(requiredParam(ctx, 'token'))
      } catch {
        ctx.status = 404
        ctx.body = { error: 'not_found' }
        return
      }
      ctx.set('Cache-Control', 'no-store')
      // This document is intentionally embeddable only by the same Studio origin.
      // The global DENY header would override frame-ancestors and break BrowserPanel.
      ctx.remove('X-Frame-Options')
      ctx.set('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'")
      ctx.type = 'text/html; charset=utf-8'
      ctx.body = viewerDocument(view.socketPath)
    },
    async agent(ctx: Context) {
      if (!ctx.state.user) { ctx.status = 401; ctx.body = { error: 'Unauthorized' }; return }
      const profile = String(ctx.get('x-hermes-profile') || body(ctx).profile || '').trim()
      if (!profile) { ctx.status = 400; ctx.body = { error: 'Profile is required' }; return }
      if (ctx.state.profile?.name !== profile) { ctx.status = 403; ctx.body = { error: 'Browser profile is not available for this user' }; return }
      const current = owner(ctx); if (!current) return
      const input = body(ctx)
      const method = String(input.method || '').trim()
      const params = input.params && typeof input.params === 'object' && !Array.isArray(input.params) ? input.params as Record<string, unknown> : {}
      let operationId: string
      if (input.operation_id == null || input.operation_id === '') operationId = randomUUID()
      else if (typeof input.operation_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.operation_id)) {
        ctx.status = 400
        ctx.body = { error: 'operation_id must be a canonical 1-128 character string' }
        return
      } else operationId = input.operation_id
      const result = await browserControl(ctx, () => registry
        ? registry.agentRequest(current, method, params, { operationId })
        : service.agentRequest(current, method, params, { operationId }))
      if (result !== undefined) ctx.body = { operation_id: operationId, result }
    },
  }
}

export function createBrowserPublicRoutes(controller: ReturnType<typeof createBrowserController>): Router {
  const router = new Router()
  router.get('/api/browser/view/:token', controller.viewDocument)
  return router
}

export function createBrowserRoutes(controller: ReturnType<typeof createBrowserController>): Router {
  const router = new Router()
  router.get('/api/browser/providers', controller.providers)
  router.post('/api/browser/providers/:providerId/select', controller.selectProvider)
  router.post('/api/browser/profile-transition', controller.transitionProfile)
  router.get('/api/browser/state', controller.state)
  router.post('/api/browser/deactivate', controller.deactivate)
  router.post('/api/browser/viewport', controller.viewport)
  router.post('/api/browser/tabs', controller.createTab)
  router.delete('/api/browser/tabs/:tabId', controller.closeTab)
  router.post('/api/browser/tabs/:tabId/activate', controller.activateTab)
  router.post('/api/browser/tabs/:tabId/navigate', controller.navigate)
  router.post('/api/browser/tabs/:tabId/navigation', controller.navigationAction)
  router.post('/api/browser/tabs/:tabId/takeover', controller.takeOver)
  router.get('/api/browser/tabs/:tabId/view', controller.issueView)
  router.post('/api/browser/agent', controller.agent)
  return router
}
