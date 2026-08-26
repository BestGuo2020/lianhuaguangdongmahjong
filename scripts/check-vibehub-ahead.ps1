# Check script: list shared (master-owned) files where vibehub is AHEAD of master.
# Purpose: catch the "vibehub fixed it first" case BEFORE it gets lost.
#   - Shared files follow master (sync merge -X theirs). If vibehub modified a shared
#     file and master did not (or did), that fix either stays only on vibehub or is
#     overwritten by master on the next sync. This script lists such differences so
#     they can be ported back to master manually.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/check-vibehub-ahead.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  # Files that vibehub always keeps its own version (online layer) - same list as sync-master-to-vibehub.ps1
  $vibehubKeep = @(
    'index.html'
    'vite.config.ts'
    'playwright.config.ts'
    'src/App.vue'
    'src/components/account/StatsOverlay.vue'
    'src/components/lobby/LobbyView.vue'
    'src/components/lobby/RoomPanel.vue'
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

  # Files present on BOTH branches (shared) are the only candidates for "vibehub ahead".
  $masterFiles = @(git ls-tree -r --name-only master)
  $vibehubFiles = @(git ls-tree -r --name-only vibehub)
  $shared = $masterFiles | Where-Object { $vibehubFiles -contains $_ }

  $differing = @(git diff --name-only master vibehub)
  $ahead = @()
  foreach ($path in $differing) {
    if ($vibehubKeep -contains $path) { continue }
    if ($shared -notcontains $path) { continue }   # branch-exclusive files are not "ahead"
    $ahead += $path
  }

  if (-not $ahead) {
    Write-Host 'OK: vibehub has no shared-file changes ahead of master.' -ForegroundColor Green
    exit 0
  }

  Write-Host 'WARNING: vibehub differs from master on these shared (master-owned) files:' -ForegroundColor Yellow
  Write-Host 'These changes live only on vibehub. Port them back to master (git checkout vibehub -- <file>)' -ForegroundColor Yellow
  Write-Host 'or they will be lost/overwritten on the next master -> vibehub sync.' -ForegroundColor Yellow
  Write-Host ''
  git diff --stat master vibehub -- $ahead
  Write-Host ''
  Write-Host 'Detailed diff (vibehub side):' -ForegroundColor Cyan
  git diff master vibehub -- $ahead | Select-Object -First 120
  exit 1
} finally {
  Pop-Location
}
