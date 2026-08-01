import Router from '@koa/router'
import type { Context } from 'koa'
import type { SteelBrowserService, BrowserOwner } from '../services/browser/steel-browser-service'

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

function viewerDocument(socketPath: string): string {
  const encodedPath = JSON.stringify(socketPath)
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hermes Browser</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fff}canvas{display:block;width:100%;height:100%;object-fit:contain;outline:none}</style></head><body><canvas tabindex="0" aria-label="Browser page"></canvas><script>(()=>{const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');let width=1280,height=720;const scheme=location.protocol==='https:'?'wss:':'ws:';const ws=new WebSocket(scheme+'//'+location.host+${encodedPath});function coords(event){const r=canvas.getBoundingClientRect();return{x:(event.clientX-r.left)*width/Math.max(1,r.width),y:(event.clientY-r.top)*height/Math.max(1,r.height)}}function send(value){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(value))}ws.onmessage=event=>{const frame=JSON.parse(event.data);if(frame.data){const image=new Image();image.onload=()=>{width=image.naturalWidth||width;height=image.naturalHeight||height;canvas.width=width;canvas.height=height;ctx.drawImage(image,0,0)};image.src='data:image/jpeg;base64,'+frame.data}};canvas.addEventListener('mousedown',event=>{canvas.focus();const p=coords(event);send({type:'mouseEvent',event:{type:'mousePressed',...p,button:['left','middle','right'][event.button]||'left',clickCount:event.detail||1}})});canvas.addEventListener('mouseup',event=>{const p=coords(event);send({type:'mouseEvent',event:{type:'mouseReleased',...p,button:['left','middle','right'][event.button]||'left',clickCount:event.detail||1}})});canvas.addEventListener('mousemove',event=>{const p=coords(event);send({type:'mouseEvent',event:{type:'mouseMoved',...p,button:'none'}})});canvas.addEventListener('wheel',event=>{event.preventDefault();const p=coords(event);send({type:'mouseEvent',event:{type:'mouseWheel',...p,button:'none',deltaX:event.deltaX,deltaY:event.deltaY}})},{passive:false});canvas.addEventListener('keydown',event=>{event.preventDefault();send({type:'keyEvent',event:{type:'keyDown',key:event.key,code:event.code,keyCode:event.keyCode,text:event.key.length===1?event.key:''}});send({type:'keyEvent',event:{type:'keyUp',key:event.key,code:event.code,keyCode:event.keyCode,text:''}})})})()</script></body></html>`
}

export function createBrowserController(service: SteelBrowserService) {
  return {
    async state(ctx: Context) {
      const current = owner(ctx); if (!current) return
      ctx.body = await service.state(current)
    },
    async createTab(ctx: Context) {
      const current = owner(ctx); if (!current) return
      const input = body(ctx)
      ctx.body = await service.createTab(current, String(input.url || 'about:blank'), input.activate !== false)
    },
    async closeTab(ctx: Context) {
      const current = owner(ctx); if (!current) return
      ctx.body = await service.closeTab(current, requiredParam(ctx, 'tabId'))
    },
    async activateTab(ctx: Context) {
      const current = owner(ctx); if (!current) return
      ctx.body = await service.activateTab(current, requiredParam(ctx, 'tabId'))
    },
    async navigate(ctx: Context) {
      const current = owner(ctx); if (!current) return
      ctx.body = await service.navigate(current, requiredParam(ctx, 'tabId'), String(body(ctx).url || ''))
    },
    async navigationAction(ctx: Context) {
      const current = owner(ctx); if (!current) return
      const action = String(body(ctx).action || '')
      if (action !== 'back' && action !== 'forward' && action !== 'reload' && action !== 'stop') {
        ctx.status = 400; ctx.body = { error: 'Invalid browser navigation action' }; return
      }
      ctx.body = await service.navigationAction(current, requiredParam(ctx, 'tabId'), action)
    },
    async viewport(ctx: Context) {
      const current = owner(ctx); if (!current) return
      ctx.body = await service.setViewport(current, body(ctx).visible === true)
    },
    async takeOver(ctx: Context) {
      const current = owner(ctx); if (!current) return
      ctx.body = await service.takeOver(current, requiredParam(ctx, 'tabId'))
    },
    async issueView(ctx: Context) {
      const current = owner(ctx); if (!current) return
      const grant = await service.issueView(current, requiredParam(ctx, 'tabId'))
      ctx.set('Cache-Control', 'no-store')
      ctx.body = { html: viewerDocument(`/api/browser/view/${encodeURIComponent(grant.token)}/socket`) }
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
      ctx.body = { operation_id: String(input.operation_id || ''), result: await service.agentRequest(current, method, params) }
    },
  }
}

export function createBrowserRoutes(controller: ReturnType<typeof createBrowserController>): Router {
  const router = new Router()
  router.get('/api/browser/state', controller.state)
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
