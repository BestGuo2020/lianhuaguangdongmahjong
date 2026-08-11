import { ref, type Ref } from 'vue'
import { DISCLAIMER_VERSION } from '../../../content/disclaimer'
import { agreeDisclaimer, getDisclaimerAgreement } from '../api/accountApi'

const STORAGE_KEY = 'lgm_disclaimer_agreed'

export function useDisclaimerGate(playerId: Ref<string>) {
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
    if (playerId.value) {
      try {
        const agreement = await getDisclaimerAgreement(playerId.value)
        if (agreement.agreed && (agreement.version ?? 0) >= DISCLAIMER_VERSION) {
          rememberAgreement()
          action()
          return
        }
      } catch {
        // 后端不可达时降级为本地确认。
      }
    }
    pendingAction = action
    open.value = true
  }

  function accept() {
    rememberAgreement()
    if (playerId.value) void agreeDisclaimer(playerId.value).catch(() => {})
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
