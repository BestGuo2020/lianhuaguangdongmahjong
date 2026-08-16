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

  Write-Host '==> switching to vibehub and merging master (conflicts -> master)'
  git checkout vibehub
  if ($LASTEXITCODE -ne 0) { throw 'git checkout vibehub failed' }
  git merge master --no-commit --no-ff -X theirs
  if ($LASTEXITCODE -ne 0) { throw 'git merge failed' }

  $unresolved = git diff --name-only --diff-filter=U
  if ($unresolved) {
    Write-Host 'unresolved conflicts remain; aborting (resolve manually, then git merge --continue):' -ForegroundColor Red
    Write-Host $unresolved
    exit 1
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
  Write-Host '==> restoring vibehub online files'
  git checkout --ours -- $vibehubKeep
  if ($LASTEXITCODE -ne 0) { throw 'git checkout --ours failed' }

  # Master-only WebSocket files that vibehub does not use.
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
  Write-Host '==> removing master-only WebSocket files'
  git rm --quiet -r -- $masterOnly
  if ($LASTEXITCODE -ne 0) { throw 'git rm failed' }

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
