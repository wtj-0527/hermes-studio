import { join } from 'path'
import { config } from '../../config'
import { BrowserEgressProxy } from './browser-egress-proxy'
import { SteelBrowserService } from './steel-browser-service'
import { SteelHttpRuntimeAdapter } from './steel-http-runtime'

const runtimeUrl = String(process.env.HERMES_STEEL_BROWSER_URL || 'http://127.0.0.1:3000')
const egressHost = String(process.env.HERMES_BROWSER_EGRESS_PROXY_HOST || '127.0.0.1')

export const steelHttpRuntime = new SteelHttpRuntimeAdapter({
  baseUrl: runtimeUrl,
  userDataRoot: join(config.appHome, 'browser', 'profiles'),
  egressProxy: new BrowserEgressProxy({ advertisedHost: egressHost }),
})

export const steelBrowserService = new SteelBrowserService({ runtime: steelHttpRuntime })
