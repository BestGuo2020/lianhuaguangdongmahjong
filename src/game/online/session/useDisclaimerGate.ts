// 纯娱乐声明同意门：仅本地 localStorage 记录首次确认（Phase 5 起不再依赖后端）。
// 声明文案实质修改时把 DISCLAIMER_VERSION +1（见 src/content/disclaimer.ts）。
import { ref, type Ref } from 'vue'

const STORAGE_KEY = 'lgm_disclaimer_agreed'

export function useDisclaimerGate(_playerId: Ref<string>) {
  const open = ref(false)
  let pendingAction: (() => void) | null = null

  function hasLocalAgreement() {
    try { return localStorage.getItem(STORAGE_KEY) === '1' } catch { return false }
  }

  function rememberAgreement() {
    try { localStorage.setItem(STORAGE_KEY, '1') } catch { /* 本次仍放行 */ }
  }

  function guard(action: () => void) {
    if (hasLocalAgreement()) return action()
    pendingAction = action
    open.value = true
  }

  function accept() {
    rememberAgreement()
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
