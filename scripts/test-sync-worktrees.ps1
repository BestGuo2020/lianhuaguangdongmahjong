# Real disposable Git repositories: tests never checkout or mutate the source repository.
$ErrorActionPreference = 'Stop'
$tempBase = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp'
$testRoot = Join-Path $tempBase ('lotus-sync-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null

function Git([string]$repo, [string[]]$arguments) {
  # Windows PowerShell 5 wraps native stderr (including successful checkout notices).
  $ErrorActionPreference = 'Continue'
  $output = & git.exe -C $repo @arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git $arguments failed: $output" }
  return $output
}
function Write-Utf8([string]$path, [string]$value) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
  [IO.File]::WriteAllText($path, $value, [Text.UTF8Encoding]::new($false))
}
function Assert($condition, [string]$message) { if (-not $condition) { throw $message } }

$syncSource = Get-Content -Raw (Join-Path $PSScriptRoot 'sync-master-to-vibehub.ps1')
$keepBlock = [regex]::Match($syncSource, '(?s)\$vibehubKeep = @\((.*?)\n  \)').Groups[1].Value
$keepPaths = @([regex]::Matches($keepBlock, "'([^']+)'") | ForEach-Object { $_.Groups[1].Value })
Assert ($keepPaths.Count -gt 30) 'Could not read keep contract'
# master-only path outside online/api (blood-flow WS entry): master adds it, vibehub deletes it,
# then master modifies it again -> sync must keep the deletion (modify/delete conflict).
$bloodFlowWsEntry = 'src/game/variants/lotus/bloodFlow/useBloodFlowRemoteGame.ts'

function New-Fixture([string]$name, [bool]$linked) {
  $repo = Join-Path $testRoot $name
  New-Item -ItemType Directory -Path $repo -Force | Out-Null
  Git $repo @('init', '-b', 'master') | Out-Null
  Git $repo @('config', 'user.name', 'Sync Test') | Out-Null
  Git $repo @('config', 'user.email', 'sync-test@example.invalid') | Out-Null
  Git $repo @('config', 'commit.gpgsign', 'false') | Out-Null
  Git $repo @('config', 'core.autocrlf', 'false') | Out-Null
  foreach ($path in $keepPaths) {
    if (-not [IO.Path]::GetExtension($path)) { $path += '/fixture.ts' }
    Write-Utf8 (Join-Path $repo $path) 'master base'
  }
  Write-Utf8 (Join-Path $repo 'shared.txt') 'base'
  Write-Utf8 (Join-Path $repo '.gitignore') ''
  Write-Utf8 (Join-Path $repo 'src/game/online/api/fixture.ts') 'WS only'
  Write-Utf8 (Join-Path $repo $bloodFlowWsEntry) 'WS only'
  foreach ($name in @('sync-master-to-vibehub.ps1', 'check-vibehub-ahead.ps1')) {
    Write-Utf8 (Join-Path $repo "scripts/$name") (Get-Content -Raw (Join-Path $PSScriptRoot $name))
  }
  Git $repo @('add', '.') | Out-Null
  Git $repo @('commit', '-m', 'base') | Out-Null
  Git $repo @('checkout', '-b', 'vibehub') | Out-Null
  foreach ($path in $keepPaths) {
    if (-not [IO.Path]::GetExtension($path)) { $path += '/fixture.ts' }
    Write-Utf8 (Join-Path $repo $path) 'P2P private'
  }
  Git $repo @('rm', 'src/game/online/api/fixture.ts') | Out-Null
  Git $repo @('rm', $bloodFlowWsEntry) | Out-Null
  Git $repo @('add', '.') | Out-Null
  Git $repo @('commit', '-m', 'P2P') | Out-Null
  Git $repo @('checkout', 'master') | Out-Null
  Write-Utf8 (Join-Path $repo 'shared.txt') 'shared blood-flow change'
  # Automatic clean merges of protected paths must also be restored.
  Write-Utf8 (Join-Path $repo 'src/App.vue') 'master updated'
  Write-Utf8 (Join-Path $repo 'src/game/online/api/fixture.ts') 'updated WS only'
  Write-Utf8 (Join-Path $repo $bloodFlowWsEntry) 'updated WS only'
  Git $repo @('add', '.') | Out-Null
  Git $repo @('commit', '-m', 'shared feature') | Out-Null
  $target = $repo
  if ($linked) {
    $target = "$repo target with spaces"
    Git $repo @('worktree', 'add', $target, 'vibehub') | Out-Null
  }
  return @{ repo = $repo; target = $target }
}

function Run-Sync($fixture, [bool]$success, [string]$label) {
  $log = Join-Path $testRoot "$label.log"
  $ErrorActionPreference = 'Continue'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fixture.repo 'scripts/sync-master-to-vibehub.ps1') *> $log
  $code = $LASTEXITCODE
  Assert (($code -eq 0) -eq $success) "Unexpected exit $code for $label; see $log"
  Assert ((Git $fixture.repo @('branch', '--show-current')) -eq 'master') "$label changed master branch"
}

$linked = New-Fixture 'linked' $true
$before = Git $linked.repo @('rev-parse', 'vibehub')
Write-Utf8 (Join-Path $linked.target 'user.txt') 'do not touch'
Run-Sync $linked $false 'dirty-target'
Assert ((Git $linked.repo @('rev-parse', 'vibehub')) -eq $before) 'Dirty target HEAD changed'
Assert ((Get-Content -Raw (Join-Path $linked.target 'user.txt')) -eq 'do not touch') 'User file changed'
# Commit the fixture user file, as a real user would; no stash or delete.
Git $linked.target @('add', 'user.txt') | Out-Null
Git $linked.target @('commit', '-m', 'user work') | Out-Null
Write-Utf8 (Join-Path $linked.repo 'user-master.txt') 'preserve master'
Run-Sync $linked $false 'dirty-master'
Git $linked.repo @('add', 'user-master.txt') | Out-Null
Git $linked.repo @('commit', '-m', 'master user work') | Out-Null
Run-Sync $linked $true 'linked-clean'
Assert ((Get-Content -Raw (Join-Path $linked.target 'shared.txt')) -eq 'shared blood-flow change') 'Shared update missing'
foreach ($path in $keepPaths) {
  if (-not [IO.Path]::GetExtension($path)) { $path += '/fixture.ts' }
  Assert ((Get-Content -Raw (Join-Path $linked.target $path)) -eq 'P2P private') "Keep changed: $path"
}
Assert (-not (Test-Path (Join-Path $linked.target 'src/game/online/api/fixture.ts'))) 'WS file resurrected'
Assert (-not (Test-Path (Join-Path $linked.target $bloodFlowWsEntry))) 'master-only blood-flow WS entry resurrected'
$synced = Git $linked.repo @('rev-parse', 'vibehub')
Run-Sync $linked $true 'idempotent'
Assert ((Git $linked.repo @('rev-parse', 'vibehub')) -eq $synced) 'No-op sync created a commit'

$local = New-Fixture 'same-directory' $false
Run-Sync $local $true 'same-directory'
Assert ((Git $local.repo @('show', 'vibehub:src/App.vue')) -eq 'P2P private') 'Local keep failed'
Assert ((Git $local.repo @('show', 'vibehub:shared.txt')) -eq 'shared blood-flow change') 'Local sync failed'
$resurrected = $true
try { Git $local.repo @('cat-file', '-e', "vibehub:$bloodFlowWsEntry") | Out-Null } catch { $resurrected = $false }
Assert (-not $resurrected) 'master-only blood-flow WS entry resurrected (local)'
Write-Host "PASS: dirty master/target, linked worktree, spaces, keep restoration, WS deletion, no-op, local fallback. Evidence: $testRoot"
