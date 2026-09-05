# 血流 E00：分支接线与基线

> 历史分支盘点与三处接线授权记录。保留当时文件归属和补丁证据，不将旧 HEAD / 未授权状态当成当前状态。执行时仍读取仓库现行 AGENTS.md 与同步脚本。
> 当前入口：[文档首页](../README.md) · [当前任务](../tasks.md) · [验收记录](../acceptance.md)。


## E06 工作流补充授权

2026-09-05，本任务用户明确回复“授权这三处血流接线”，同意按 `docs/blood-flow/archive/p2p-protected.patch` 在 P2P 分支的 `src/App.vue`、`src/components/lobby/LobbyView.vue`、`src/game/core/contracts/gamePort.ts` 接入玩法选择、可选能力与共享 UI。仅此三处受保护接线纳入本任务授权；保留 P2P 联机、房主主题同步/客机锁定、开局参数及模型密钥私有边界。没有删 keep 项或引用旧 Phase 11V 授权。本补充取代下文盘点时的“E06 尚未授权”状态记录。

盘点日期：2026-09-05。当时规则计划已归档，现行依据见[规则与体验约定](../rules.md)。下表为授权前 E00 盘点快照；三处接线已获授权，范围以上方授权记录为限。

## 分支与工作树

| 工作树 | 分支 | 开始时 HEAD / 状态 |
|---|---|---|
| `D:/vueprojects/lianhua_guangma` | master | `d784cbf9d2e88ccb45082bf40e106a4f45c8c3a6`；仅三份血流计划文档未跟踪 |
| `D:/vueprojects/lianhua_guangma/work/vibehub-theme11v` | vibehub | `8f728b67390e04fc4d96292d992acead9d31970e`；干净 |
| `C:/Users/He Guo/.codex/worktrees/e6cd/lianhua_guangma` | codex/pixi-table-renderer | `9d62615b927e3791be549482fe5d924a18bb9cb3`；不属于本次实施，不操作 |

`powershell -NoProfile -File scripts/check-vibehub-ahead.ps1` 退出 0：没有 keep 清单以外、两分支同时存在的共享差异。人工检查了 `git diff master vibehub -- src/game/variants/lotus/lotusGame.ts src/game/core/contracts/gamePort.ts`：差异是 remoteControllers、无头房主、承诺牌墙、开局屏障及房主语音隔离，保留在 P2P。没有反向覆盖 master。

三份已有未跟踪文档都是本任务的输入：实施计划、体验设计与历史数值实验。本批将它们原样纳入版本控制（实施计划只另记实施进度），不 stash、不删除，也不提交其他任务文件。

## 同步方案

`scripts/sync-master-to-vibehub.ps1` 现在从 master 工作树读取 `git worktree list --porcelain`，识别 `refs/heads/vibehub` 的既有路径；先核验源、目标均干净，再在目标工作树合并、恢复 keep、删除 masterOnly、提交。包含空格的路径按单个参数传递。目标工作树不存在时保留原单目录切换模式。

禁止强制签出、移除或移动工作树、覆盖脏文件。merge 未启动时不执行恢复；残留合并失败时保留现场。默认不 push。check 脚本已将 `useGame.test.ts`、`shared/settlement/settlementTimeline.ts` 视为受保护文件，而旧 sync 清单漏列这两项；本批补齐保留清单，未删除任何 keep 项。

独立 Git 实验 `scripts/test-sync-worktrees.ps1` 已验证：源脏、目标脏时 HEAD 和用户文件不变；既有目标、空格路径、单目录回退；全部 keep 文件逐项保留；modify/delete 的 WS 文件不复活；二次同步不产生提交。实验与日志位于系统临时目录 `lotus-sync-tests-*`，不冒充已随提交交付。

## 逐文件接线清单

表内 `*` 是同一归属的文件族；既有文件按同步脚本的实际清单判定。

| 路径 | master 职责 | P2P 职责 / 接入方式 | 同步后核验 |
|---|---|---|---|
| `variants/lotus/bloodFlow/{config,types}.ts` | E01 独立规则与私有/公开契约 | 共享，暂不装配 | 字节一致，旧入口不开放 |
| `variants/lotus/patterns/{types,decompose,catalog,evaluate,score}.ts`、`fixtures/*` | E01/E02 评分纯逻辑与黄金输入 | 房主复用；客机不结算 | 全部黄金输入在两端同结果 |
| `variants/lotus/bloodFlow/{state,claimWindow,winBatch,ledger,roundLifecycle}.ts` | E03 账本与续行 | 房主注入同一共享引擎 | 物理牌守恒、批次幂等 |
| `lotusState.ts`、`lotusTurnOrchestrator.ts`、`lotusTileFlow.ts`、`lotusKong.ts`、`lotusSettlement.ts` | E03 保留旧流程的新规则分支 | 共享，不带 P2P 传输 | 两分支旧规则回归 |
| `lotusControllers.ts`、`lotusAi.ts`、`lotusSelectors.ts`、`lotusHuman.ts` | E04 可见输入、锁手动作、听牌 | 共享决策契约 | 无对手暗手及墙顺序 |
| `core/rules/{ruleVariants,ruleset}.ts` | E04 显式配置、场景过滤 | 共享；房间需单独能力协商 | 未知键不降级；WS 不接收新键 |
| `variants/lotus/lotusGame.ts` | master 单机装配 | **keep**；已有 controllers/ruleset 注入，但无血流状态能力出口 | 保留 remoteControllers/headless/开局屏障；共享实现不会自动接线 |
| `core/contracts/{gamePort,activeGamePort}.ts` | 可选能力与活跃端口 | **keep**；需要分别投射公开能力 | 不丢 P2P initialWall/dice 参数 |
| `src/App.vue`、`core/local/useGame.ts`、`components/lobby/{LobbyView,RoomPanel}.vue` | E04 本地开关与 WS 隔离 | **keep / AGENTS 禁止直接改**；现有房主主题同步和客机锁定保留 | 原 P2P 大厅、房间、主题入口原样 |
| `components/table/{BloodFlowWinCard,GameTableHud}.vue`、`three/{bloodFlowWinPile,tableTilePresenter,tableRenderTypes}.ts` | E05 公开展示 | 共享能力读取，避免 P2P 壳层重复实现 | 多响显示引用不参与实体计数 |
| `components/settlement/BloodFlowRoundLedger.vue` | E05 新共享流水组件 | 共享；由各自壳层注入 | 无暗手字段 |
| `components/settlement/SettlementOverlay.vue` | master 局末挂载 | **keep**；另行装配共享流水组件 | 不覆盖 P2P 房间续局逻辑 |
| `online/host/{hostGameRunner,localStateToSnapshot,lotusRemotePlayerController}.ts` | 无这些 P2P 文件 | E06 房主权威、按席位快照、动作窗口；只在 P2P 分支独立提交 | 版本/身份/窗口校验，重连逐批一致 |
| `online/useVibeRemoteGame.ts`、`online/vibe/{vibeLlm,matchStatsRecorder}.ts` | 不引入到 WS | E06/E08 P2P 独有接线 | 每局计数一次，LLM 房主单请求 |
| `online/{protocol,orchestration,presentation,state,session}/*` | 旧 WS 不增加血流事件 | **keep / 部分 AGENTS 禁止直接改**；E06 解码、脱敏、恢复、去重 | 不能借同步脚本改写受保护壳层 |
| `core/presentation/{animeAudioPolicy,useAudio}.ts`、`llm/animeFixedTtsExecutor.ts`、音频资源 | E00/E07 回归保护 | 共享原动作出口 | 不新增替代 hu/zimo，不双播 |
| `shared/settlement/settlementTimeline.ts`、`shared/runtime/{matchLifecycle,timerScheduler}.ts` | 旧行为保留；血流局内绕开终局 | **keep**；优先新增独立共享血流模块 | 不提前 round_settled / revealHands |
| `game/llm/{schema,candidates,prompt,llmController,conditionalReasoning,runtime}.ts` | E08 私有候选、预算、局末感言 | 共享，P2P runtime 单独接入 | 关闭感言不关闭决策 |
| `online/api/*`、`online/useRemoteGame.ts`、`online/transport/roomSocket.ts` | masterOnly；旧 WS | 同步继续保持删除 | 不复活 WS 模块 |
| `index.html`、`vite.config.ts`、`playwright.config.ts`、`package.json` | 本分支配置 | **keep** | 使用 P2P 自有构建与 E2E 配置 |

除 `src/App.vue` 外，表内路径均省略 `src/game/` 或 `src/` 的显然公共前缀；实施时以仓库真实路径为准。

E01 不需要修改任何受保护既有接线，已通过新增共享模块完成。E00 盘点时 E06 尚未取得工作流补充授权；后来三处具体接线授权见本文件开头。已有 `ruleset` 注入只能替换旧单胡计算，不能代替批次窗口、血流可选端口或客户端恢复。到 E05 完成时，应给出可复核最小补丁：GameCapabilities 增加 `bloodFlow?: BloodFlowPublicState`；lotusGame 为新配置装配共享生命周期并投射该字段，保留所有 headless/remote 参数；snapshot mapper/decoder/reconciler 显式白名单映射公开批次；SettlementOverlay 仅添加共享流水组件挂载。具体 diff 依赖 E03/E05 的最终接口，当前不虚构可应用补丁、不将 E06 标成已解决，也不请求空泛授权。

## A01 原动作音基线

`bloodFlow/audioBaseline.test.ts` 固定 75 个场景：五主题 × 真人/规则 AI/LLM × 两旧模式的合法自摸/点炮/抢杠路径。classic 单机无普通点炮动作，15 个不适用组合没有伪造入口。该测试调用**既有结算模块**，不是新玩法模拟，不发真实 LLM/TTS 请求。

| 被测边界 | 每次动作回调 | 原 hu/zimo 请求次数 |
|---|---:|---:|
| legacy 结算、真人或规则 AI、五主题 | 1 | 1；llmAnime 随后由 lotusGame 既有外层过滤 |
| classic 结算、真人或规则 AI、前四主题 | 1 | 1 |
| classic 结算、llmAnime | 1 | 0，使用固定人声出口 |
| 任一旧模式结算、已配置 LLM 座位 | 1 | 0，沿用原 LLM 人声通道 |

自摸对应 `zimo.mp3`，点炮/抢杠对应 `hu.mp3`。llmAnime 动作映射分别为 `zimo`/`hu`/`qiangganghu`；`AnimeFixedTtsExecutor` 已有测试验证成功一次请求、相同事件重复零次、开始 audible 后不再补播回退。主音色未播出而失败时允许备用音色请求，不将“请求两次”误记为“播放两次”。四个非二次元主题保留 legacy 路由，二次元所有身份使用 fixed-line。

验收命令：`node node_modules/vitest/vitest.mjs run src/game/variants/lotus/bloodFlow/audioBaseline.test.ts src/game/llm/animeFixedTtsExecutor.test.ts src/game/core/presentation/animeAudioPolicy.test.ts src/game/core/presentation/useAudio.test.ts`，退出 0，193 项通过。此证据是模块路由与 spy 次数，不是浏览器实听、真实 TTS 或端到端混合房间验收；后者仍留 E07/E09。

## 前端基线

在任何生产游戏改动前：`pnpm typecheck` 退出 0；`pnpm test` 退出 0，186 文件通过、2 跳过；1714 测试通过、4 跳过。无既有失败。环境提示无法读取用户 pnpm auth.ini / Git 全局 ignore，但本次检查实际成功。`pnpm exec vitest` 在此环境找不到可执行文件，定向测试使用仓库已安装的 `node node_modules/vitest/vitest.mjs`，没有安装或升级依赖。
