// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const openSessionSearchMock = vi.hoisted(() => vi.fn())
const requestMock = vi.hoisted(() => vi.fn())
const clearThemeBackgroundCacheMock = vi.hoisted(() => vi.fn())
const messageMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
const mockAppStore = vi.hoisted(() => ({
  sidebarOpen: true,
  sidebarCollapsed: false,
  connected: true,
  serverVersion: 'test',
  latestVersion: '',
  isDocker: false,
  updateAvailable: false,
  clientOutdated: false,
  updating: false,
  toggleSidebar: vi.fn(),
  toggleSidebarCollapsed: vi.fn(),
  closeSidebar: vi.fn(),
  doUpdate: vi.fn(),
  reloadClient: vi.fn(),
}))

vi.mock('@/composables/useSessionSearch', () => ({
  useSessionSearch: () => ({
    openSessionSearch: openSessionSearchMock,
  }),
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => mockAppStore,
}))

vi.mock('@/api/client', () => ({
  getStoredUserId: () => 7,
  getStoredUsername: () => 'admin',
  isStoredSuperAdmin: () => {
    const token = localStorage.getItem('hermes_api_key') || ''
    try {
      return JSON.parse(atob(token.split('.')[1] || '')).role === 'super_admin'
    } catch {
      return false
    }
  },
  request: requestMock,
}))

vi.mock('@/api/theme', () => ({
  clearThemeBackgroundCache: clearThemeBackgroundCacheMock,
}))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    useRoute: () => ({ name: 'hermes.chat' }),
    useRouter: () => ({ push: vi.fn(), hasRoute: () => true }),
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
  createI18n: () => ({
    global: { locale: { value: 'en' }, setLocaleMessage: vi.fn() },
  }),
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({ isDark: false }),
}))

vi.mock('/logo.png', () => ({
  default: 'logo.png',
}))

vi.mock('@/components/layout/ProfileSelector.vue', () => ({
  default: { name: 'ProfileSelector', template: '<div />' },
}))

vi.mock('@/components/layout/ModelSelector.vue', () => ({
  default: { name: 'ModelSelector', template: '<div />' },
}))

vi.mock('@/components/layout/LanguageSwitch.vue', () => ({
  default: { name: 'LanguageSwitch', template: '<div />' },
}))

vi.mock('@/components/layout/ThemeSwitch.vue', () => ({
  default: { name: 'ThemeSwitch', template: '<div />' },
}))

vi.mock('@/components/common/RouteLinkItem.vue', () => ({
  default: {
    name: 'RouteLinkItem',
    props: ['to', 'active'],
    template: '<a class="route-link-item" :class="{ active }" href="#"><slot /></a>',
  },
}))

vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<any>('naive-ui')
  return {
    ...actual,
    useMessage: () => messageMock,
    NButton: {
      template: '<button v-bind="$attrs"><slot /></button>',
    },
    NModal: {
      props: ['show'],
      template: '<div v-if="show" class="n-modal-stub"><slot /></div>',
    },
    NSelect: {
      template: '<div />',
    },
  }
})

import AppSidebar from '@/components/layout/AppSidebar.vue'

function fakeJwt(payload: Record<string, unknown>) {
  return `header.${btoa(JSON.stringify(payload)).replace(/=/g, '')}.signature`
}

describe('AppSidebar navigation', () => {
  beforeEach(() => {
    localStorage.clear()
    openSessionSearchMock.mockClear()
    mockAppStore.serverVersion = 'test'
    mockAppStore.latestVersion = ''
    mockAppStore.isDocker = false
    mockAppStore.updateAvailable = false
    mockAppStore.clientOutdated = false
    mockAppStore.updating = false
    mockAppStore.sidebarCollapsed = false
    mockAppStore.reloadClient.mockClear()
    mockAppStore.doUpdate.mockReset()
    mockAppStore.doUpdate.mockResolvedValue(false)
    requestMock.mockReset().mockResolvedValue({ ok: true })
    clearThemeBackgroundCacheMock.mockReset().mockResolvedValue(undefined)
    messageMock.success.mockReset()
    messageMock.error.mockReset()
  })

  it('keeps page-sidebar-only actions out of the app sidebar', () => {
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    expect(wrapper.text()).not.toContain('sidebar.search')
    expect(wrapper.text()).not.toContain('sidebar.reloadClientVersion')
    expect(wrapper.find('.sidebar-return-tab').exists()).toBe(true)
  })

  it('uses short group labels and keeps group folding active when collapsed', async () => {
    mockAppStore.sidebarCollapsed = true
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    expect(wrapper.classes()).toContain('collapsed')
    expect(wrapper.findAll('.nav-group-label span').map(node => node.text())).toEqual([
      'sidebar.groupAgentShort',
      'sidebar.groupMonitoringShort',
      'sidebar.groupToolsShort',
      'sidebar.groupSystemShort',
    ])

    const agentGroup = wrapper.findAll('.nav-group')[0]
    expect(agentGroup.find('.nav-group-items').attributes('style')).toBeUndefined()

    await agentGroup.find('.nav-group-label').trigger('click')
    expect(agentGroup.find('.nav-group-items').attributes('style')).toContain('display: none')
  })

  it('keeps MCP visible for admins while hiding device management', () => {
    localStorage.setItem('hermes_api_key', fakeJwt({ sub: '2', role: 'admin' }))
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
          NButton: true,
        },
      },
    })

    expect(wrapper.text()).toContain('sidebar.mcp')
    expect(wrapper.text()).toContain('sidebar.theme')
    expect(wrapper.text()).not.toContain('sidebar.devices')
  })

  it('uses the regular update button to open Docker upgrade guidance', async () => {
    mockAppStore.isDocker = true
    mockAppStore.updateAvailable = true
    mockAppStore.latestVersion = '0.6.29'
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
        },
      },
    })

    const button = wrapper.get('.update-btn')
    expect(button.classes()).not.toContain('docker-update-btn')
    expect(button.text()).toContain('sidebar.updateVersion')

    await button.trigger('click')

    expect(mockAppStore.doUpdate).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('sidebar.dockerUpdateGuide')
  })

  it('keeps the original npm update action outside Docker', async () => {
    mockAppStore.isDocker = false
    mockAppStore.updateAvailable = true
    mockAppStore.latestVersion = '0.6.29'
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
        },
      },
    })

    await wrapper.get('.update-btn').trigger('click')

    expect(mockAppStore.doUpdate).toHaveBeenCalledOnce()
    expect(wrapper.text()).not.toContain('sidebar.dockerUpdateGuide')
  })

  it('keeps the login session intact when browser deactivation fails during logout', async () => {
    localStorage.setItem('hermes_api_key', 'still-authenticated')
    requestMock
      .mockRejectedValueOnce(new Error('runtime session release failed'))
      .mockResolvedValueOnce({ ok: true })
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
        },
      },
    })

    await wrapper.get('.logout-item').trigger('click')
    await flushPromises()

    expect(requestMock).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' })
    expect(localStorage.getItem('hermes_api_key')).toBe('still-authenticated')
    expect(clearThemeBackgroundCacheMock).not.toHaveBeenCalled()
    expect(messageMock.error).toHaveBeenCalledWith('sidebar.logoutFailed')

    await wrapper.get('.logout-item').trigger('click')
    await flushPromises()
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(clearThemeBackgroundCacheMock).toHaveBeenCalledWith(7)
    expect(localStorage.getItem('hermes_api_key')).toBeNull()
  })

  it('does not issue concurrent browser deactivation requests on repeated logout clicks', async () => {
    localStorage.setItem('hermes_api_key', 'still-authenticated')
    let finishDeactivate!: () => void
    requestMock.mockReturnValueOnce(new Promise(resolve => { finishDeactivate = () => resolve({ ok: true }) }))
    const wrapper = mount(AppSidebar, {
      global: {
        stubs: {
          ProfileSelector: true,
          ModelSelector: true,
          LanguageSwitch: true,
          ThemeSwitch: true,
        },
      },
    })

    await wrapper.get('.logout-item').trigger('click')
    await wrapper.get('.logout-item').trigger('click')
    expect(requestMock).toHaveBeenCalledOnce()
    expect(wrapper.get('.logout-item').attributes('disabled')).toBeDefined()

    finishDeactivate()
    await flushPromises()
    expect(clearThemeBackgroundCacheMock).toHaveBeenCalledWith(7)
    expect(localStorage.getItem('hermes_api_key')).toBeNull()
  })
})
