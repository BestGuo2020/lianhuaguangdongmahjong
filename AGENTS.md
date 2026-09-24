# AGENTS.md

莲花广麻：可在浏览器游玩的四人广东麻将（Vue 3 + Three.js 前端 + Python 后端）。支持东风场/半庄场、莲花广麻（白板癞子）与莲花麻将（翻精癞子）两种规则。

项目名称中的“莲花”指地方、县城及当地麻将玩法来源，不表示花卉，也不是视觉母题。

必须遵守：

- “莲花广麻”“莲花麻将”只用于玩法、规则、规则说明和相关业务标识。
- 不从“莲花”二字推导项目 Logo、页面样式、主题、桌布、牌墙、牌背、牌河、皮肤、粒子、徽章、动作字或结算表现。
- 不新增莲花、荷花、荷叶、花瓣、莲花奖牌、莲花印章、莲花绽放等项目级视觉符号。
- 不构造“莲华首席”“莲花数据城”等由名称派生的世界观。
- 不因玩法名称推导岭南、粤式茶楼或其他未经产品决策确认的地域视觉。
- 五个主题的视觉来源必须是各自的主题概念，不能来自“莲花”地名。

## 双分支同步（重要工作流）

本仓库有两条长期分支，**只有联机层不同**：

| 分支 | 联机方式 | 角色 |
|---|---|---|
| `master` | WebSocket（`src/game/online/transport/roomSocket.ts` + `src/game/online/api/`） | **UI 主开发分支**：牌桌/规则/组件改动只在这里做并提交 |
| `vibehub` | P2P（`src/game/online/transport/vibeRoomTransport.ts` + vibe SDK） | 同步分支：从 master 自动同步 UI，保留自己的联机层 |

**必须遵守的规则：**

1. UI/规则/牌桌改动一律在 `master` 分支提交；提交后**必须**运行 `pnpm sync:vibehub` 同步到 vibehub（脚本要求 master 工作区干净，有未提交改动会中止并提示）。
2. 联机层文件两边本质不同，同步时脚本自动保留 vibehub 版本（脚本内 `$vibehubKeep` 清单）：
   - `src/App.vue`、`src/game/core/local/useGame.ts`（远程入口）
   - `src/components/lobby/*`、`src/components/account/*`
   - `src/game/online/orchestration/*`、`presentation/*`、`session/*`、`state/*`
   - `index.html`、`vite.config.ts`、`playwright.config.ts`、`src/content/disclaimer.ts`
   **不要**手动在 vibehub 上改这些文件，也不要尝试把它们合并进 master。
3. 其余游戏 UI/规则文件（`src/components/table/*`、`src/game/core/*`、`src/game/variants/lotus/*` 等）跟随 master，同步时自动采用 master 版本。
4. 文件归属完整清单、冲突处理与清单维护方法见 `docs/branch-sync-workflow.md`。

**vibehub 领先（反向移植）**：共享文件的修复应**一律先在 master 做**。若发现 vibehub 上已有共享文件的改动而 master 没有（例如 vibehub 先修了某个 bug），必须移植回 master，否则下次同步可能被 master 版覆盖丢失。流程：
1. 运行 `powershell -File scripts/check-vibehub-ahead.ps1`（`pnpm sync:vibehub` 也会自动先跑），列出 vibehub 领先的共享文件；
2. 审查 `git diff vibehub master -- <文件>`，区分「真实修复」（移植）与「联机特定改造」（如引用 `useVibeRemoteGame` 的改动，不移植）；
3. 移植：`git checkout vibehub -- <文件>` → master 提交 → `pnpm sync:vibehub`（此时两边一致，同步无损）。

## 后端仓库

`backend/` 是**独立的 git 仓库**（`D:/PycharmProjects/linahua-mahjong-backend` 主仓库的 linked worktree，前端仓库的 .gitignore 忽略了它）。修改后端代码后，需在 `backend/` 目录内单独 `git commit`（后端自己的 main 分支），与前端分支互不影响。

## 测试

- 前端：`pnpm test`（vitest，`src` 下）
- 后端：`backend/.venv/Scripts/python.exe -m pytest tests -q`（在 `backend/` 目录内）

### 联机（P2P）问题一律线上验收（2026-09-10 决定）

本地 `mockVibeHub` **不具备 VibeHub SDK 的真实环境**，因此它只用于**确定性逻辑/流程**断言，不再为它维护联机行为断言：

- 它能覆盖：承诺洗牌与权威 worker（`tests/e2e/blood-flow.room.spec.ts`）、大厅/主题/刷新恢复（`blood-flow.lobby.spec.ts`）、协议与 replica 逻辑（`src/game/variants/lotus/bloodFlow/network/network.test.ts`）。
- **它覆盖不了**（实测四类线上缺陷全部无法本地复现）：单包超限导致的静默发送失败、分片在直连 SDK 的订阅者处被丢弃、对端 peer id 漂移、收帧饥饿与失联判定。原因是 mock 在进程内投递、无大小上限与加密、peer id 恒定、无 WebRTC/中继抖动。
- 因此联机行为（房间面板/roster、传输、断线恢复、结算同步）统一在**线上部署**验收：`vibehubcli`（`vibehub-windows-x64.exe update --slug B5AJupT1 --dir dist`）更新后，用 `tmp/online_test` 的两个账号跑 `tests/e2e/online-two-accounts-two-east-matches.spec.ts` 里的血流用例（2 真人 + 2 普通机器人 / 2 真人 + 2 大模型机器人），取证落 `tmp/bf-online-evidence/`。
- **触发条件（2026-09-12 收敛）**：改动触及 P2P 传输 / 房间 / roster / 重连 / 结算同步时**必须**上线跑两场；日常 AI、规则、UI 改动以本地全量测试 + 单机 e2e 为准，不必每次上线。
- **本地跑真 SDK 不可行（2026-09-12 实测，两条路都不通）**：① 匿名进房被 SDK 拒绝（room/信令接口一律要求登录凭证，服务端 `POST /api/sdk/rooms` 无条件 401，文档里的"匿名"只指中继节点贡献）；② 本地真实登录也失败（本地伪装域名不受信任）。`VITE_VIBE_REAL=1` 开关与 vite 平台 API 代理保留为验证痕迹（默认关闭、仅影响 dev）；`mockVibeHub` 保留为本地默认联调环境，本地不存在可用的真实 P2P 环境。
- 依据与逐项记录见 `docs/vibehub-adaptation-checklist.md` 的「线上整场验收结果」与「联机验收策略」两节。

## 长任务轮询（避免触发上游循环拦截）

dsh 通过阿里云百炼 Qwen Token Plan 网关（`qwen-token-plan-cn`）访问模型，该网关**在服务端**检测「同一 tool call（同名 + 同参数）在多轮里重复」，命中即整轮拒绝：`Repetitive tool calls detected in the conversation history...`（dsh 只把它透传为 `PI_AI_ERROR`）。由于重复调用已经留在会话历史里，**之后每个请求都会被拒**——补发新消息、让模型换参数、压缩历史都救不回来，会话说死。

**必须遵守（长时间训练/评测监控时尤其重要）：**

1. 任何等待/轮询类命令（sleep + 查状态）**每次都必须唯一**：命令里带一行注释 `# poll <序号/总数> <时间戳>`，并让 description 也带序号；**禁止发出与历史逐字相同的命令**（command、description、timeoutMs 全都一致才算重复）。
2. 同一模式的轮询在**一个会话里最多出现 2 次**；第 3 次必须换策略：换命令形态、换检查内容，或改用 job 通知机制。
3. 等长任务结束优先用 dsh 的 job/通知机制（job 完成会主动通知），不要用 sleep 轮询空等；必须 sleep 时单轮 ≤10 分钟，且第 1 条仍然适用。
4. 一旦看到 `Repetitive tool calls detected`：**不要在该会话里重试**（重试必然同样失败）。停下该会话，改开新会话接手，或先修复会话日志再继续（修复脚本与流程见 `~/.dsh/_dedup_loop_calls.mjs`）。
