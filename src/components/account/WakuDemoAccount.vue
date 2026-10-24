<script setup lang="ts">
defineProps<{ authenticated: boolean; accountName: string; loading: boolean; error: string }>()
defineEmits<{ login: []; logout: [] }>()
</script>

<template>
  <div class="lobby-account-slot" data-wakudemo-account>
    <div class="waku-account" :class="{ authenticated }">
      <div>
        <b>{{ authenticated ? (accountName || 'WakuDemo 玩家') : 'WakuDemo 账号' }}</b>
        <small>{{ authenticated ? '已安全登录' : '登录后关联平台身份' }}</small>
      </div>
      <button
        type="button"
        data-action-role="secondary"
        :disabled="loading"
        @click="authenticated ? $emit('logout') : $emit('login')"
      >{{ loading ? '处理中…' : authenticated ? '退出' : '登录' }}</button>
    </div>
    <p v-if="error" class="waku-auth-error" role="alert">{{ error }}</p>
  </div>
</template>
