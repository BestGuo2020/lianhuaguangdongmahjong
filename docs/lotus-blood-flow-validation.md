# 血流实施验收记录

## E06 实际大厅与恢复补充

用户批准的三个 UI 接线文件已应用，P2P 提交 `0ec0a5a`；SDK 独有装配 `1e25060`；会话与 mock 刷新恢复修复 `2c95228`。未扩大受保护文件修改范围：旧 session parser 不认识新键，通过新 `vibe/bloodFlowSessionStore` 适配其现有契约；旧模式仍走原解析器。

真实 Chromium、同浏览器 BroadcastChannel mock：实际大厅选择血流、两真人两规则 AI、房主主题锁定、客户端刷新后恢复本人席位/手牌/胡牌楼，1 passed（约 47.6 秒）。另外 SDK 形状的房间适配用实际 Worker 完成东风场和逐局承诺重洗，1 passed（约 19.4 秒）。修复了 mock 对相同 peer ID 刷新不重发 welcome 导致错误自选房主的问题，并有专门回归。以上不等于真实 VibeHub 云端/WebRTC 验收；本地 DEV 路径明确使用 mock，真实 SDK 仍需生产域与登录环境。

## E07 演出队列与 E08 共享决策基础

E07：按主番基础权重四档展示，首次大番 1400ms/顶级 1600ms、重复 400ms、完整演出 8 秒冷却。积压只合并视觉摘要，最多一个中央标题/四席反馈，历史恢复不补播。五主题的真实 Chromium 演出/十次连续胡/恢复测试 5 passed（约 21.1 秒）。新视觉组件没有任何音频或规则 API；原动作语音独立桥接并按事件去重，旧两模式音频基线继续通过。450ms 胡牌节拍已在权威窗口实现，deadline 从 opensAt 后起算；模拟入口显式关掉节拍仅为加速规则压力，不冒充实际节奏。

E08 共享部分：单机独立 LLM 选择包含胡/过、当前得分、硬胡、听口与锁手影响；忽略返回的自由发言。默认普通 2800ms、关键胡/过 4500ms；非默认用户预算保留，关闭个人超时时仍受 P2P 权威 deadline 减 250ms 约束。请求身份绑定 epoch/round/window/seat/request，重复请求单飞，过期丢弃，强制/锁手动作无需模型。全局 40000ms 默认值视为旧模式默认，血流使用自己的推荐预算，不修改旧配置。

局末感言是另一队列：仅 llm/llmAnime 且确认本局结束才生成；每个有配置席位最多一句、固定座位顺序。其他三主题在请求前拦截；取消感言不会取消合法打牌请求。TTS 复用原客户端与网关，增加单条 AbortSignal，不创建服务，不全局静音。P2P 专有模型装配和最终联合验证仍在进行。

## E06 进行中：共享协议与权威协调

新增传输无关 authority/replica/protocol、浏览器 Worker backend；协议包含规则版本、epoch、全局 sequence、round/window/batch 标识。已验证四端实际 TypeScript 引擎一局，批次/快照两种到达顺序、重复动作/重放、私有手牌边界、未知版本拒绝、座位冒充拒绝、12 秒恢复宽限、房主暂停/中断与局末计数一次；`network/network.test.ts` 5 passed，约 1.5 秒，typecheck 退出 0。

新增全员 opening_done 屏障：动画期间权威暂停，全部真人就绪才恢复完整响应截止时间。共享端口支持外部权威视图、座位旋转、两骰/发牌展示及迟到回调取消；不会在客机创建第二套权威引擎。本节还不是 E06 完成：SDK 接线、两真人两 AI、真实网络、重连页面恢复与受保护 UI 补丁尚待后续验证。

## E05 胡牌楼与公开流水（2026-09-05）

新增 BloodFlowWinCard、BloodFlowRoundLedger、bloodFlowWinPile 并接实际 Three.js 牌桌。桌面每层 4 张/3 层，小屏每层 3 张/2 层，超出显示收纳次数；布局只引用公开 source/record，不参与牌库。完整重建直接放置当前记录，不重播历史动画。主番按基础权重优先展示，包含项说明使用中文名称且不冒充加分。

48 项布局测试覆盖四视角 × 桌面/紧凑 × 每家 0/1/4/12/40/80，重复事件输入不重复增长，原数据不变。真实 Chromium 容量/点击流水测试：568×320、1280×720 两项通过（约 34.3 秒）；四视角赢家/来源映射一项通过（约 12 秒）。截图发现并修复血流小横屏的手牌最小点击槽溢出、计数徽标与按钮相交，新增视口边界和交叠断言。截图是独立压力 fixture（明确不作为牌数或规则验收），路径 `test-results/blood-flow-piles-568.png`、`blood-flow-piles-1280.png`，未将忽略文件当作受控交付。

局末由 HUD 打开血流流水，旧单赢家结算壳仅对其他模式显示。`pnpm typecheck`、`pnpm build`、`git diff --check` 均退出 0。五主题全部尺寸/GPU实测、演出队列以及网络重建验收仍留后续阶段。

## E04 单机与规则 AI（2026-09-05）

新增 `useBloodFlowGame` 端口、后台 engineWorker、独立听牌 Worker、seatView 脱敏边界和可见输入规则 AI。继续复用现有两骰/翻精/发牌动画；记录真实第 53 张发牌作为庄家第十四张，开局胡改由新窗口询问。AI 不读取对手暗手或墙序，支持首胡拒绝阈值（默认接受），锁手仅有合法动作；错误弃牌选择确定性回退。局末 nextRound 轮庄并完成 4/8 局，普通胡不亮全桌。

只在开发服务 URL `?bloodFlow=1` 开放单机规则选择；两个生产开关仍 false。切到 WS 会重置为旧规则，roomApi 明确拒绝发送新键。未知规则 ID 不再静默显示为旧玩法。首胡提示包含实际番型/倍率/付款与锁手说明，听牌提示独立展示自摸和点炮单家金额；同批多响的公共剩余量只计一次 source。新增底分标签参数，血流为 10，旧模式仍 100。本地取消人工倒计时的既有设置保留。

真实 Chromium：`E2E_REUSE_ONLY=1 E2E_PORT=4184 node node_modules/@playwright/test/cli.js test tests/e2e/blood-flow.local.spec.ts --workers=1`，3 passed，约 57.9 秒。包含正常大厅开关与 WS 隔离、实际 Vue 端口和 Worker 固定种子东风场/半庄场，经 nextRound 完成 4/8 局，总分 8000；补验底分标签的 opt-in 用例 1 passed。测试服务仅前端，未启动/修改 Python 服务；没有把这些结果当作 P2P 通过。

`pnpm test` 退出 0：3313 passed、6 skipped（master 当前配置会发现工作树中的测试，因此该数不是新增测试数）。`pnpm build` 退出 0，生成独立 worker 与 engineWorker 包；仅既有 chunk 体积提示。后续小范围标签修改的 `pnpm typecheck` 退出 0。原 75 个动作音基线仍通过；新模式完整演出/声音门禁继续在 E07/E08 验证。

## E03 状态机实施记录（2026-09-05）

新增共享 `bloodFlow/engine.ts`，配合 state/claimWindow/winBatch/ledger/roundLifecycle。采用独立权威引擎复用既有两骰翻精/墙尾摸牌、吃牌与 E02 评分纯逻辑；不改造旧 single-win 终局副作用。E04/E06 通过新端口适配，计划内原 lotusTurnOrchestrator/lotusSettlement 等旧流程继续保留。

固定牌验证三响、重复响应、锁手后再自摸、已胡仍付款、末张收齐响应/过/超时、抢补杠三响回退原碰且无杠费、天胡明确第十四张、暗杠/风杠一次收费。另 40 个固定种子整局逐动作检查：136 张实体和四副面子有效张数、零和积分、允许负分、窗口推进上限。`node node_modules/vitest/vitest.mjs run src/game/variants/lotus/bloodFlow/engine.test.ts src/game/variants/lotus/bloodFlow/simulation.test.ts` 退出 0，6 passed，约 1.23 秒。模拟使用合法动作压力策略，不是平衡或 AI 强度结论。

公共流水通过显式对象构造，不含完整分解、精牌分配或暗手；私有评分证据只在权威 Map 中。局末从已提交账本汇总，不重扣历史分，不发送旧 round_settled 或全桌亮牌指令。当前尚无浏览器/P2P 装配，不将引擎测试视为玩法已开放。

## E02 评分器实施记录（2026-09-05）

实现 `patterns/{decompose,catalog,evaluate,score}.ts`：完整副露、数顺/风顺/箭顺、七对、独立特殊手；按实例限制外来精牌，白板仅替代精面或自身。自然/替代分解分别计分，最高支付择优，稳定 ID 次序；风杠不冒充普通刻/杠。没有改变旧规则导出或权重。

61 个 E01 黄金输入接入真实评分器并全部通过；新增 7 个边界场景、1 个极端精牌压力和 1 个 Worker 生命周期场景。规则及评分定向命令 `node node_modules/vitest/vitest.mjs run src/game/variants/lotus/patterns src/game/variants/lotus/lotusRules.test.ts` 在 Worker 测试增加前报告 246 passed；Worker 单独 1 passed，`pnpm typecheck` 退出 0。没有截断合法分解。

极端 8 张精牌 + 4 张受限白板搜索约 5～6 秒，结果为清幺九+四暗刻软自摸 46 倍；不能虚称该输入必然封顶。已合并等价精牌资源、按计数缓存失败状态并去除等价部分分解，浏览器提供可取消 Worker 服务，不发布半截结果；E04 装配时必须使用 Worker/后台引擎，不能直接在 UI 线程循环调用同步评分器。该耗时不是帧率指标。无入口开放，E03～E09 尚未通过验收。

规则版本：`lotus-blood-flow-v1`。首批日期：2026-09-05。范围：E00/E01；新模式的单机、P2P 开关均为 false。未发布、未推送远程仓库。

## 交付内容与阶段边界

- E00：工作树同步脚本、真实临时 Git 仓库回归、[逐文件分支接线及音频基线](lotus-blood-flow-branch-integration.md)。未触碰受禁止的 P2P 既有装配文件。
- E01：独立只读配置、私有评分证据/公开事件类型；48 个手牌黄金输入、13 个算术/逐分解择优输入。66 个测试检查配置要求、覆盖完整性、输入实体合法性与旧模式隔离；没有调用尚未实现的新评分器。
- E02～E09：未实施。整体玩法、真实 P2P、UI 尺寸/GPU、千局模拟、LLM/TTS 和完整场次均未验收。不得将下面旧模式回归数量理解成血流玩法通过。

## 本批检查

| 检查 | 结果 |
|---|---|
| 初始 `pnpm typecheck` | 退出 0 |
| 初始 `pnpm test` | 退出 0；1714 passed、4 skipped，186 文件通过、2 跳过 |
| `powershell -NoProfile -File scripts/check-vibehub-ahead.ps1` | 初始退出 0，无共享领先差异 |
| `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-sync-worktrees.ps1` | 退出 0；源/目标脏文件保护、空格工作树、keep、WS 删除、重复同步、单目录回退通过 |
| `node node_modules/vitest/vitest.mjs run src/game/variants/lotus/bloodFlow/config.test.ts` | 退出 0；66 passed |
| 音频定向命令（见分支清单） | 退出 0；193 passed，包含新增 75 个基线矩阵场景 |
| 修改后 `pnpm typecheck` | 退出 0 |
| master 完整 `pnpm test` | 修正临时样本位置后退出 0；1855 passed、4 skipped，188 文件通过、2 跳过 |
| master `pnpm build` | 退出 0，含 vue-tsc；保留原大型 chunk 提示，未进行无关打包重构 |
| `git diff --check` | 退出 0 |
| 真实分支 `pnpm sync:vibehub` | 退出 0；在既有 P2P 工作树完成，master 未切分支，无 push |
| P2P `pnpm test` | 退出 0；1086 passed、2 skipped，105 文件通过、1 跳过，使用该分支自己的 Vitest 配置 |
| P2P `node node_modules/vitest/vitest.mjs run game/variants/lotus/bloodFlow` | 退出 0；本批新增 141 项全部通过 |
| P2P `pnpm build` | 退出 0，含 vue-tsc；同样仅有大型 chunk 提示 |
| 受保护文件与共享文件检查 | `git diff 8f728b6 vibehub -- src/App.vue src/game/core/contracts/gamePort.ts src/game/variants/lotus/lotusGame.ts src/game/online src/components/lobby src/components/settlement/SettlementOverlay.vue` 为空；两分支新 bloodFlow/patterns 目录 diff 为空 |

原有完整测试的 4 个跳过仍是跳过，不属于本批新增失败。构建包仅为旧玩法加未启用基础模块，并非 E09 可发布的新玩法包。大型日志在忽略的 `work/blood-flow-*.log`，此文保留可追溯摘要，不声称日志已纳入提交。

本批曾引入测试发现范围问题：临时 Git 样本最初放在 `work/`，被 Vitest 当作 44 个测试文件收集失败，实际 1855 项单测通过。已把脚本样本移至系统临时目录并清理本次生成的三个仓库，未修改 Vitest 配置或排除实际测试；以下最终回归以修正后的重跑为准。

## 提交与继续实施

E00/E01 主提交：master `07c3388`（`feat: define blood-flow rules and contracts`）；对应 P2P 同步提交 `eb2ca2d`。以上最终检查针对这两份实现。验收结果随后以文档提交补记并再次同步；该文档提交不改变已验收代码。

真实同步前 check 脚本列出的两个差异是本批 master 新改动（同步脚本与工作流说明），并非 P2P 新修复；已核对后正常合并。P2P 的 pnpm 命令自动从本地存储恢复已有锁定依赖，未添加依赖或变更 manifest/lockfile。两个工作树最终均干净。未运行 E2E，因为本批没有开放游戏入口、改动 UI 或 P2P 运行接线；完整游戏 E2E 仍属于后续阶段，未勾选。

下一阶段 E02 应把两个 JSON fixture 集连接到真实评分器测试，逐一实现并审查替代/自然分解，尤其是外来精按本张、白板受限、点炮补刻归属、风杠、包含关系与同分解硬胡。当前 fixtures 的 `winning=false` pending 杠输入表示不接受未提交的副露作为已完成评分输入；抢杠权威流程需要回退原碰后重新组装输入。

E06 的既有受保护壳层仍需最小具体补丁及范围授权，当前没有拿旧 Phase 11V 授权替代。回退本批可直接 revert 主提交；因为两个入口始终关闭，没有进行中的血流房间需要迁移。
