<script setup lang="ts">
import { computed } from 'vue'
import { login, logout, vibeError, vibeStatus, vibeUser } from '../../game/online/vibe/vibeClient'

const displayName = computed(() => vibeUser.value?.name || 'VibeHub 用户')
const busy = computed(() => vibeStatus.value === 'initializing' || vibeStatus.value === 'authenticating')

async function onLogin() {
  await login()
}
</script>

<template>
  <div class="vibe-auth" data-vibe-auth>
    <template v-if="vibeUser">
      <span class="vibe-auth-status" aria-live="polite">已登录：{{ displayName }}</span>
      <button type="button" class="vibe-auth-logout" @click="logout">退出游戏账号</button>
    </template>
    <template v-else>
      <span class="vibe-auth-status" aria-live="polite">{{ vibeError ? '登录失败' : '登录后开始多人对战' }}</span>
      <button type="button" class="vibe-auth-login" :disabled="busy" @click="onLogin">
        {{ busy ? '连接中…' : '登录' }}
      </button>
      <p v-if="vibeError" class="vibe-auth-error" role="alert">{{ vibeError }}</p>
    </template>
  </div>
</template>

<style scoped>
.vibe-auth {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: stretch;
}
.vibe-auth-status {
  color: #d0c39e;
  font-size: 13px;
  letter-spacing: 0.1em;
}
.vibe-auth-login {
  padding: 12px 20px;
  border: 1px solid #d2aa58;
  border-radius: 3px;
  background: linear-gradient(135deg, #b98737, #d9b65d 48%, #956622);
  color: #182218;
  font-weight: 800;
  letter-spacing: 0.12em;
  cursor: pointer;
}
.vibe-auth-login:disabled {
  filter: grayscale(0.6);
  opacity: 0.55;
  cursor: not-allowed;
}
.vibe-auth-logout {
  padding: 11px 16px;
  border: 1px solid rgba(213, 184, 112, 0.5);
  border-radius: 5px;
  background: rgba(8, 28, 20, 0.88);
  color: #e5d5ad;
  font-weight: 800;
  cursor: pointer;
}
.vibe-auth-error {
  margin: 0;
  color: #e0a06a;
  font-size: 13px;
}
</style>
