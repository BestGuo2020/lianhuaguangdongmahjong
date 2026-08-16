# 同步脚本：master（UI 主分支）→ vibehub（P2P 联机分支）
# 用途：UI/规则/牌桌改动只需在 master 上做，跑本脚本即可同步到 vibehub。
# 原理：
#   1. git merge master --no-commit -X theirs —— 冲突一律采用 master 版（UI 以 master 为准）
#   2. 对「联机装配文件」checkout --ours —— 恢复 vibehub 自己的版本（P2P 联机逻辑）
#   3. 删除 master 独有、vibehub 不用的 WS 版联机文件（api/、roomSocket、useRemoteGame 等）
# 要求：master 工作区必须干净（未提交改动先 commit 或 stash）。
param(
  [switch]$Push
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  Write-Host '==> 检查 master 工作区'
  git checkout master
  $dirty = git status --porcelain
  if ($dirty) {
    Write-Host 'master 有未提交改动，请先提交或 stash：' -ForegroundColor Red
    Write-Host $dirty
    exit 1
  }

  Write-Host '==> 切到 vibehub 并合并 master（冲突采用 master 版）'
  git checkout vibehub
  git merge master --no-commit --no-ff -X theirs
  if ($LASTEXITCODE -ne 0) { throw 'merge 失败' }

  $unresolved = git diff --name-only --diff-filter=U
  if ($unresolved) {
    Write-Host '存在未解决的冲突，中止（请手工解决后 git merge --continue）：' -ForegroundColor Red
    Write-Host $unresolved
    exit 1
  }

  # ── 恢复 vibehub 自己的联机装配文件（ours = vibehub 当前分支版本）──────────
  # 这些文件两边内容本质不同（P2P vs WS），永远保留 vibehub 版。
  $vibehubKeep = @(
    'index.html'
    'vite.config.ts'
    'playwright.config.ts'
    'src/App.vue'
    'src/components/account/StatsOverlay.vue'
    'src/components/lobby/LobbyView.vue'
    'src/components/lobby/RoomPanel.vue'
    'src/components/shell/GameShellHeader.vue'
    'src/content/disclaimer.ts'
    'src/game/core/local/useGame.ts'
    'src/game/online/orchestration/remoteActionController.ts'
    'src/game/online/orchestration/remoteActionController.test.ts'
    'src/game/online/orchestration/remoteLobbyController.ts'
    'src/game/online/orchestration/remoteLobbyController.test.ts'
    'src/game/online/orchestration/remoteMatchLifecycle.ts'
    'src/game/online/orchestration/remoteMatchLifecycle.test.ts'
    'src/game/online/orchestration/requestCoordinator.ts'
    'src/game/online/orchestration/requestCoordinator.test.ts'
    'src/game/online/orchestration/snapshotReconciler.ts'
    'src/game/online/orchestration/snapshotReconciler.test.ts'
    'src/game/online/presentation/openingTimeline.ts'
    'src/game/online/presentation/openingTimeline.test.ts'
    'src/game/online/session/remoteSessionStore.ts'
    'src/game/online/session/remoteSessionStore.test.ts'
    'src/game/online/session/useDisclaimerGate.ts'
    'src/game/online/state/remoteGameState.ts'
    'src/game/online/state/remoteGameState.test.ts'
  )
  Write-Host '==> 恢复 vibehub 联机文件'
  git checkout --ours -- $vibehubKeep
  if ($LASTEXITCODE -ne 0) { throw 'checkout --ours 失败' }

  # ── 删除 master 独有、vibehub 不用的 WS 版联机文件 ────────────────────────
  # 这些文件只存在于 master（WebSocket 版），vibehub 不引用，避免死代码。
  $masterOnly = @(
    'src/game/online/api'
    'src/game/online/session/remoteRoomLifecycle.ts'
    'src/game/online/session/remoteRoomLifecycle.test.ts'
    'src/game/online/session/useRoomAvailability.ts'
    'src/game/online/transport/roomSocket.ts'
    'src/game/online/transport/roomSocket.test.ts'
    'src/game/online/useRemoteGame.ts'
    'src/game/online/useRemoteGame.test.ts'
    'tests/e2e/remote-lotus-legacy.smoke.spec.ts'
  )
  Write-Host '==> 删除 master 独有 WS 联机文件'
  git rm --quiet -r -- $masterOnly
  if ($LASTEXITCODE -ne 0) { throw 'git rm 失败' }

  Write-Host '==> 提交同步'
  git commit -m 'sync: 从 master 同步 UI 改动（自动生成）'
  if ($LASTEXITCODE -ne 0) { throw 'commit 失败' }

  if ($Push) {
    Write-Host '==> 推送 vibehub'
    git push origin vibehub
  }

  Write-Host '==> 切回 master'
  git checkout master
  Write-Host '同步完成。建议在 vibehub 上跑一遍测试：pnpm test' -ForegroundColor Green
} finally {
  Pop-Location
}
