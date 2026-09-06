import { ref } from 'vue'
import { DISCLAIMER_VERSION } from '../../../content/disclaimer'
import { agreeMyDisclaimer, getMyDisclaimerAgreement } from '../api/accountApi'

const STORAGE_KEY = 'lgm_disclaimer_agreed'

/** 联机免责声明：按当前登录身份（wakudemo-<uid>）记录在服务端。 */
export function useDisclaimerGate() {
  const open = ref(false)
  let pendingAction: (() => void) | null = null

  function hasLocalAgreement() {
    try { return localStorage.getItem(STORAGE_KEY) === '1' } catch { return false }
  }

  function rememberAgreement() {
    try { localStorage.setItem(STORAGE_KEY, '1') } catch { /* 本次仍放行 */ }
  }

  async function guard(action: () => void) {
    if (hasLocalAgreement()) return action()
    try {
      const agreement = await getMyDisclaimerAgreement()
      if (agreement.agreed && (agreement.version ?? 0) >= DISCLAIMER_VERSION) {
        rememberAgreement()
        action()
        return
      }
    } catch {
      // 未登录或后端不可达时降级为本地确认。
    }
    pendingAction = action
    open.value = true
  }

  function accept() {
    rememberAgreement()
    void agreeMyDisclaimer().catch(() => {})
    open.value = false
    const action = pendingAction
    pendingAction = null
    action?.()
  }

  function decline() {
    open.value = false
    pendingAction = null
  }

  return { open, guard, accept, decline }
}
