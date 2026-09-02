param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sourceDir = Join-Path $ProjectRoot 'public/tiles'
$outputRoot = Join-Path $ProjectRoot 'public/themes/llm-anime/v1'
$faceDir = Join-Path $outputRoot 'tiles'
New-Item -ItemType Directory -Force -Path $faceDir | Out-Null

# 牌面必须保持项目标准清晰样式：直接复用标准牌面，不叠加渐变、星星、边框或装饰图案。
Copy-Item -Path (Join-Path $sourceDir '*.png') -Destination $faceDir -Force

$backWidth = 256
$backHeight = 352
$back = [System.Drawing.Bitmap]::new($backWidth, $backHeight, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
try {
  $backColor = [System.Drawing.Color]::FromArgb(189, 91, 72)
  for ($y = 0; $y -lt $backHeight; $y += 1) {
    for ($x = 0; $x -lt $backWidth; $x += 1) { $back.SetPixel($x, $y, $backColor) }
  }
  $graphics = [System.Drawing.Graphics]::FromImage($back)
  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $bounds = [System.Drawing.Rectangle]::new(0, 0, $backWidth, $backHeight)
    # 纯色牌背，仅保留简洁的米白/金色纹章线条，避免蓝紫粉渐变与星芒。

    $ring = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(205, 201, 169, 101), 3)
    try { $graphics.DrawEllipse($ring, 52, 100, 152, 152) } finally { $ring.Dispose() }

    $seal = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(235, 244, 237, 223), 6)
    try {
      for ($petal = 0; $petal -lt 5; $petal += 1) {
        $angle = -[Math]::PI / 2 + $petal * ([Math]::PI * 2 / 5)
        $petalX = 128 + [Math]::Cos($angle) * 32 - 23
        $petalY = 176 + [Math]::Sin($angle) * 32 - 23
        $graphics.DrawEllipse($seal, [single]$petalX, [single]$petalY, 46, 46)
      }
      $graphics.DrawEllipse($seal, 117, 165, 22, 22)
    } finally { $seal.Dispose() }
  } finally { $graphics.Dispose() }
  $back.Save((Join-Path $outputRoot 'tile-back.png'), [System.Drawing.Imaging.ImageFormat]::Png)
} finally { $back.Dispose() }

Write-Output "Generated llmAnime tile faces and tile back in $outputRoot"
