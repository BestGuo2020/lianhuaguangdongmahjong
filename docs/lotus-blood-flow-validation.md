# 血流实施验收记录

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
