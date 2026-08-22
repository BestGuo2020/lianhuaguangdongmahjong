# 双分支同步工作流（master → vibehub）

> 目的：前端界面（牌桌、规则、组件）只改一次，两个分支都能用。

## 分支定位

| 分支 | 联机方式 | 角色 |
|---|---|---|
| `master` | WebSocket（`roomSocket.ts` + HTTP API） | **UI 主开发分支**：牌桌/规则/组件改动只在这里做 |
| `vibehub` | P2P（`vibeRoomTransport.ts` + vibe SDK） | 同步分支：从 master 自动同步 UI，保留自己的联机层 |

## 日常流程

1. 在 `master` 上改 UI → 提交
2. 跑同步：
   ```bash
   pnpm sync:vibehub
   # 或：powershell -ExecutionPolicy Bypass -File scripts/sync-master-to-vibehub.ps1
   ```
3. 脚本自动完成：切到 vibehub → merge master（冲突采用 master 版）→ 恢复 vibehub 联机文件 → 删除 WS 版死代码 → 提交 → 切回 master

## 哪些文件跟随 master（自动采用 master 版）

- 牌桌/组件：`MahjongTile.vue`、`MahjongTable3D.vue`、`GameTableHud.vue`、`PlayerSeat.vue`、`RulesPanel.vue`、`SettlementOverlay.vue`、`staticTableScene.ts`、`tableTilePresenter.ts` 等
- 游戏核心：`game/core/contracts/*`、`game/core/local/*`、`game/core/rules/*`、`game/shared/runtime/*`
- 莲花引擎：`game/variants/lotus/*`

## 哪些文件 vibehub 永远保留自己的版本（脚本自动恢复）

这些是**联机装配/本质差异**文件，两边内容必然不同，改联机时需两边分别改：

- `src/App.vue`、`src/game/core/local/useGame.ts`（远程入口）
- `src/game/core/contracts/activeGamePort*`、`gamePort*`（P2P 远端端口与权威开局参数）
- `src/components/lobby/*`（大厅）、`src/components/account/*`、`src/components/shell/GameShellHeader.vue`
- `src/game/online/orchestration/*`、`presentation/*`、`session/*`、`state/*`（联机编排）
- `src/game/online/protocol/*`、`src/game/shared/settlement/settlementTimeline.ts`、
  `src/game/shared/runtime/{matchLifecycle,timerScheduler}.ts`、
  `src/game/variants/lotus/lotusGame.ts`（P2P 权威边界/无头房主扩展）
- `index.html`、`vite.config.ts`、`playwright.config.ts`、`src/content/disclaimer.ts`

## 注意

- 脚本要求 **master 工作区干净**（先提交或 stash）
- 同步完成后建议在 vibehub 上跑 `pnpm test` 验证
- 若改动涉及联机层（大厅/登录/传输），master 和 vibehub 需各自实现——这是两套后端的本质差异，无法合并
- 清单维护：改脚本里的 `$vibehubKeep`（保留 vibehub 版）与 `$masterOnly`（删除）数组
