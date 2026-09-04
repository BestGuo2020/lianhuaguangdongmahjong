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
