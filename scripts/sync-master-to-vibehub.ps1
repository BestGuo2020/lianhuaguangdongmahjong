# Sync script: master (UI main branch) -> vibehub (P2P online branch)
# UI/rule/table changes are made on master only; run this script to sync them to vibehub.
# Steps:
#   1. git merge master --no-commit -X theirs  (conflicts resolve to master's version)
#   2. checkout --ours on online-assembly files (keep vibehub's own P2P logic)
#   3. git rm master-only WebSocket files (api/, roomSocket, useRemoteGame, ...)
# Requires: master working tree must be clean (commit or stash pending changes first).
param(
  [switch]$Push
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  Write-Host '==> checking master working tree'
  git checkout master
  if ($LASTEXITCODE -ne 0) { throw 'git checkout master failed' }
  $dirty = git status --porcelain
  if ($dirty) {
    Write-Host 'master has uncommitted changes; commit or stash them first:' -ForegroundColor Red
    Write-Host $dirty
    exit 1
  }

  # Nothing to sync when master has no commits that vibehub lacks.
  $newCommits = @(git log vibehub..master --oneline)
  if (-not $newCommits) {
    Write-Host 'master has no new commits; nothing to sync' -ForegroundColor Green
    exit 0
  }

  Write-Host '==> checking vibehub-ahead shared files (port-back candidates)'
  & (Join-Path $PSScriptRoot 'check-vibehub-ahead.ps1')
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'WARNING: vibehub has shared-file changes ahead of master (listed above).' -ForegroundColor Yellow
    Write-Host 'Review them; port real fixes back to master (git checkout vibehub -- <file>)' -ForegroundColor Yellow
    Write-Host 'before they are overwritten by this sync. Continuing anyway...' -ForegroundColor Yellow
  }

  # Files that must always keep vibehub's own version (P2P vs WS differ by nature).
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

  # Master-only WebSocket files that vibehub does not use.
  # Note: a plain merge keeps vibehub's deletions, so these paths usually do not exist
  # after merging; they only reappear when master MODIFIES one of them
  # (modify/delete conflict). Resolve by keeping the deletion.
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

  Write-Host '==> switching to vibehub and merging master (conflicts -> master)'
  git checkout vibehub
  if ($LASTEXITCODE -ne 0) { throw 'git checkout vibehub failed' }
  git merge master --no-commit --no-ff -X theirs

  # 新版 git（ort 合并后端，2.34+）对 modify/delete 冲突不随 -X theirs 自动解决：
  # master-only 文件在 vibehub 上已删除、而 master 又修改了它们时会留下未解决冲突。
  # 按本脚本既定语义处理：这些文件对 vibehub 不存在 → 一律保留删除。
  $unresolved = @(git diff --name-only --diff-filter=U)
  foreach ($file in $unresolved) {
    if ($file -like 'src/game/online/api/*' -or $file -in $masterOnly) {
      git rm --quiet -f -- $file
      Write-Host "==> 按删除解决 modify/delete 冲突: $file"
    }
  }
  $unresolved = @(git diff --name-only --diff-filter=U)
  if ($unresolved) {
    Write-Host 'unresolved conflicts remain; aborting (resolve manually, then git merge --continue):' -ForegroundColor Red
    Write-Host $unresolved
    git merge --abort
    exit 1
  }

  # Files that must always keep vibehub's own version (P2P vs WS differ by nature); 定义见上方。
  Write-Host '==> restoring vibehub online files'
  git checkout --ours -- $vibehubKeep
  if ($LASTEXITCODE -ne 0) { throw 'git checkout --ours failed' }

  # Master-only WebSocket files that vibehub does not use（定义见上方）：合并后若仍存在则移除。
  $existing = $masterOnly | Where-Object { Test-Path $_ }
  if ($existing) {
    Write-Host '==> removing master-only WebSocket files'
    git rm --quiet -r -- $existing
    if ($LASTEXITCODE -ne 0) { throw 'git rm failed' }
  } else {
    Write-Host '==> no master-only files to remove'
  }

  Write-Host '==> committing sync'
  git commit -m 'sync: sync UI changes from master (auto generated)'
  if ($LASTEXITCODE -ne 0) { throw 'git commit failed' }

  if ($Push) {
    Write-Host '==> pushing vibehub'
    git push origin vibehub
    if ($LASTEXITCODE -ne 0) { throw 'git push failed' }
  }

  Write-Host '==> switching back to master'
  git checkout master
  Write-Host 'sync done. It is recommended to run tests on vibehub: pnpm test' -ForegroundColor Green
} finally {
  Pop-Location
}
