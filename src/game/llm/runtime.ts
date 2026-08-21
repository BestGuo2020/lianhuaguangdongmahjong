// LLM 运行时装配 —— 供 App.vue 在创建本地人机引擎时注入 AI 控制器（座位 1-3）。
// 决策：读取 localStorage 配置（readLlmConfig），启用且已填 Key 时才返回 LLM 控制器，
// 否则返回 null（引擎沿用默认启发式 AI）。配置变更后刷新页面生效。
// stats 用 reactive 包装：设置面板的 computed 依赖它才能实时刷新（普通对象不会触发重算）。
import { reactive } from 'vue'
import type { PlayerController } from '../core/controllers/playerController'
import type { LotusController } from '../variants/lotus/lotusControllers'
import { CoreLlmController, LotusLlmController, createLlmStats, type LlmControllerHooks, type LlmControllerStats } from './llmController'
import { readLlmConfig } from './config'

export interface LocalLlmRuntime<C> {
  controllers: C[] | null
  stats: LlmControllerStats
  enabled: boolean
}

function baseRuntime(): LocalLlmRuntime<never> {
  const { config, enabled } = readLlmConfig()
  const stats = reactive(createLlmStats())
  const usable = enabled && Boolean(config.apiKey) && Boolean(config.baseUrl)
  return { controllers: null, stats, enabled: usable }
}

/** 莲花广麻（lotus-classic）本地人机座位 1-3 的 LLM 控制器。 */
export function createLocalLlmControllers(hooks: LlmControllerHooks = {}): LocalLlmRuntime<PlayerController> {
  const base = baseRuntime()
  if (!base.enabled) return base
  const controllers: PlayerController[] = [
    new CoreLlmController(readLlmConfig().config, hooks, base.stats),
    new CoreLlmController(readLlmConfig().config, hooks, base.stats),
    new CoreLlmController(readLlmConfig().config, hooks, base.stats),
  ]
  return { ...base, controllers }
}

/** 莲花麻将（lotus-legacy）本地人机座位 1-3 的 LLM 控制器。 */
export function createLotusLlmControllers(hooks: LlmControllerHooks = {}): LocalLlmRuntime<LotusController> {
  const base = baseRuntime()
  if (!base.enabled) return base
  const config = readLlmConfig().config
  const controllers: LotusController[] = [
    new LotusLlmController(config, hooks, base.stats),
    new LotusLlmController(config, hooks, base.stats),
    new LotusLlmController(config, hooks, base.stats),
  ]
  return { ...base, controllers }
}
