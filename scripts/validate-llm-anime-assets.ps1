param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [int]$RuntimeCardMaxBytes = 358400
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$characters = @('claude', 'deepseek', 'doubao', 'gemini', 'glm', 'gpt', 'grok', 'kimi', 'minimax', 'mistral', 'muse', 'qwen')
$kinds = @('call', 'win')
$errors = [System.Collections.Generic.List[string]]::new()

function Test-ImageSize {
  param([string]$Path, [int]$Width, [int]$Height, [string]$Label)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    $errors.Add("missing $Label`: $Path")
    return
  }
  $image = [System.Drawing.Image]::FromFile($Path)
  try {
    if ($image.Width -ne $Width -or $image.Height -ne $Height) {
      $errors.Add("invalid $Label dimensions $($image.Width)x$($image.Height): $Path")
    }
  } finally { $image.Dispose() }
}

function Test-ActionImage {
  param([string]$Path, [string]$Label)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    $errors.Add("missing $Label`: $Path")
    return
  }
  $image = [System.Drawing.Image]::FromFile($Path)
  try {
    if ($image.Width -ne $image.Height -or $image.Width -lt 1024 -or $image.Width -gt 1254) {
      $errors.Add("invalid $Label dimensions $($image.Width)x$($image.Height): $Path")
    }
  } finally { $image.Dispose() }
}

foreach ($character in $characters) {
  foreach ($kind in $kinds) {
    $source = Join-Path $ProjectRoot "assets-src/llm-anime/characters/$character/actions/$kind.png"
    $runtime = Join-Path $ProjectRoot "public/themes/llm-anime/v1/characters/$character/actions/$kind.jpg"
    Test-ActionImage $source 'source action card'
    Test-ActionImage $runtime 'runtime action card'
    if (Test-Path -LiteralPath $runtime -PathType Leaf) {
      $bytes = (Get-Item -LiteralPath $runtime).Length
      if ($bytes -gt $RuntimeCardMaxBytes) {
        $errors.Add("runtime action card exceeds $RuntimeCardMaxBytes bytes ($bytes): $runtime")
      }
    }
  }
}

$tileDir = Join-Path $ProjectRoot 'public/themes/llm-anime/v1/tiles'
$tiles = @(Get-ChildItem -LiteralPath $tileDir -Filter '*.png' -File)
if ($tiles.Count -ne 34) { $errors.Add("expected 34 themed tile faces, found $($tiles.Count): $tileDir") }
foreach ($tile in $tiles) { Test-ImageSize $tile.FullName 75 100 'themed tile face' }
Test-ImageSize (Join-Path $ProjectRoot 'public/themes/llm-anime/v1/tile-back.png') 256 352 'themed tile back'

if ($errors.Count) {
  $errors | ForEach-Object { Write-Error $_ }
  exit 1
}

Write-Output "Validated 24 action cards, 34 tile faces, and 1 tile back."
