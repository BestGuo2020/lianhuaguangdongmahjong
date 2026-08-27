import { onMounted, ref } from 'vue'
import {
  beginWakuDemoLogin,
  getWakuDemoLoginSession,
  logoutWakuDemo,
  type WakuDemoAccount,
} from '../api/authApi'

const ERROR_MESSAGES: Record<string, string> = {
  authorization_cancelled: '已取消 WakuDemo 授权',
  state_mismatch: '登录校验失败，请重新登录',
  authorization_request_expired: '登录请求已过期，请重试',
  authorization_code_already_used: '登录凭据已使用，请重新登录',
  pkce_or_authorization_code_rejected: '登录凭据校验失败，请重试',
  token_endpoint_timeout: 'WakuDemo 登录服务响应超时',
  token_endpoint_unavailable: '暂时无法连接 WakuDemo 登录服务',
  account_endpoint_timeout: 'WakuDemo 账户服务响应超时',
  access_token_rejected: '登录已过期，请重新登录',
}

function consumeCallbackResult(): string {
  const url = new URL(window.location.href)
  const result = url.searchParams.get('wakudemo_login')
  const code = url.searchParams.get('wakudemo_error')
  if (!result) return ''
  url.searchParams.delete('wakudemo_login')
  url.searchParams.delete('wakudemo_error')
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  if (result === 'error') return ERROR_MESSAGES[code ?? ''] ?? 'WakuDemo 登录失败，请稍后重试'
  return ''
}

export function useWakuDemoAuth() {
  const authenticated = ref(false)
  const account = ref<WakuDemoAccount | null>(null)
  const loading = ref(true)
  const error = ref('')

  async function refresh() {
    loading.value = true
    try {
      const session = await getWakuDemoLoginSession()
      authenticated.value = session.authenticated
      account.value = session.authenticated ? session.account : null
    } catch {
      authenticated.value = false
      account.value = null
      if (!error.value) error.value = '登录状态检查失败，请稍后重试'
    } finally {
      loading.value = false
    }
  }

  function login() {
    error.value = ''
    beginWakuDemoLogin()
  }

  async function logout() {
    loading.value = true
    try {
      await logoutWakuDemo()
      authenticated.value = false
      account.value = null
      error.value = ''
    } catch {
      error.value = '退出登录失败，请稍后重试'
    } finally {
      loading.value = false
    }
  }

  onMounted(() => {
    error.value = consumeCallbackResult()
    void refresh()
  })

  return { authenticated, account, loading, error, login, logout, refresh }
}

