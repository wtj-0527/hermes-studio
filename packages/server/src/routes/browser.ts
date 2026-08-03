import { createBrowserController, createBrowserPublicRoutes, createBrowserRoutes } from '../controllers/browser'
import { browserProviderRegistry, managedBrowserService } from '../services/browser'

const controller = createBrowserController(managedBrowserService, browserProviderRegistry)

export const browserPublicRoutes = createBrowserPublicRoutes(controller)
export const browserRoutes = createBrowserRoutes(controller)
