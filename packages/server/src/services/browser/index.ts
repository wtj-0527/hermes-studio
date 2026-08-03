import { config } from '../../config'
import { BrowserEgressProxy } from './browser-egress-proxy'
import { BrowserProviderRegistry } from './provider-registry'
import { ElectronBrowserControlProvider, ManagedBrowserControlProvider } from './provider-adapters'
import { ManagedBrowserService } from './managed-browser-service'
import { HttpBrowserRuntimeAdapter } from './http-browser-runtime'
import { readBrowserRuntimeToken, resolveBrowserRuntimeTokenFile } from './browser-runtime-token-file'
import { findUserById, userCanAccessProfile } from '../../db/hermes/users-store'

const runtimeUrl = String(process.env.HERMES_BROWSER_RUNTIME_URL || 'http://127.0.0.1:3000')
const egressBindHost = String(process.env.HERMES_BROWSER_EGRESS_PROXY_BIND_HOST || '127.0.0.1')
const egressHost = String(process.env.HERMES_BROWSER_EGRESS_PROXY_HOST || '127.0.0.1')
const browserRuntimeTokenFile = resolveBrowserRuntimeTokenFile(process.env, config.appHome)

export const httpBrowserRuntime = new HttpBrowserRuntimeAdapter({
  baseUrl: runtimeUrl,
  ...(browserRuntimeTokenFile ? { apiTokenProvider: async () => await readBrowserRuntimeToken(browserRuntimeTokenFile) } : {}),
  egressProxy: new BrowserEgressProxy({ bindHost: egressBindHost, advertisedHost: egressHost }),
})

export const managedBrowserService = new ManagedBrowserService({
  runtime: httpBrowserRuntime,
  ownerAuthorized: owner => {
    const user = findUserById(owner.userId)
    return Boolean(user && user.status === 'active' && (user.role === 'super_admin' || userCanAccessProfile(user.id, owner.profile)))
  },
})

export const browserProviderRegistry = new BrowserProviderRegistry({
  preferredProviderIds: String(process.env.HERMES_DESKTOP || '').trim().toLowerCase() === 'true'
    ? ['electron-local', 'managed-runtime']
    : ['managed-runtime', 'electron-local'],
})
browserProviderRegistry.register(new ElectronBrowserControlProvider({ appHome: config.appHome }))
browserProviderRegistry.register(new ManagedBrowserControlProvider(managedBrowserService))
