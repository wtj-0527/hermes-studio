import { createBrowserController, createBrowserRoutes } from '../controllers/browser'
import { steelBrowserService } from '../services/browser'

export const browserRoutes = createBrowserRoutes(createBrowserController(steelBrowserService))
