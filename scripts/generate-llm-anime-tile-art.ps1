param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sourceDir = Join-Path $ProjectRoot 'public/tiles'
$outputRoot = Join-Path $ProjectRoot 'public/themes/llm-anime/v1'
$faceDir = Join-Path $outputRoot 'tiles'
New-Item -ItemType Directory -Force -Path $faceDir | Out-Null

function Add-FourPointStar {
  param(
    [System.Drawing.Graphics]$Graphics,
    [single]$CenterX,
    [single]$CenterY,
    [single]$OuterRadius,
    [System.Drawing.Color]$Color
  )
  $inner = $OuterRadius * 0.24
  $points = [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new($CenterX, $CenterY - $OuterRadius),
    [System.Drawing.PointF]::new($CenterX + $inner, $CenterY - $inner),
    [System.Drawing.PointF]::new($CenterX + $OuterRadius, $CenterY),
    [System.Drawing.PointF]::new($CenterX + $inner, $CenterY + $inner),
    [System.Drawing.PointF]::new($CenterX, $CenterY + $OuterRadius),
    [System.Drawing.PointF]::new($CenterX - $inner, $CenterY + $inner),
    [System.Drawing.PointF]::new($CenterX - $OuterRadius, $CenterY),
    [System.Drawing.PointF]::new($CenterX - $inner, $CenterY - $inner)
  )
  $brush = [System.Drawing.SolidBrush]::new($Color)
  try { $Graphics.FillPolygon($brush, $points) } finally { $brush.Dispose() }
}

Get-ChildItem -LiteralPath $sourceDir -Filter '*.png' | ForEach-Object {
  if ($_.Name -eq 'tile-back.png') { return }
  $source = [System.Drawing.Bitmap]::FromFile($_.FullName)
  try {
    $canvas = [System.Drawing.Bitmap]::new($source.Width, $source.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($canvas)
      try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $rect = [System.Drawing.Rectangle]::new(0, 0, $canvas.Width, $canvas.Height)
        $wash = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
          $rect,
          [System.Drawing.Color]::FromArgb(42, 136, 174, 255),
          [System.Drawing.Color]::FromArgb(34, 245, 138, 205),
          42
        )
        try { $graphics.FillRectangle($wash, $rect) } finally { $wash.Dispose() }

        $border = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(132, 157, 128, 232), 1.2)
        try { $graphics.DrawRectangle($border, 2, 2, $canvas.Width - 5, $canvas.Height - 5) } finally { $border.Dispose() }
        Add-FourPointStar $graphics 8 10 4 ([System.Drawing.Color]::FromArgb(155, 106, 197, 255))
        Add-FourPointStar $graphics ($canvas.Width - 8) ($canvas.Height - 10) 4 ([System.Drawing.Color]::FromArgb(145, 255, 129, 205))
        $graphics.DrawImage($source, 0, 0, $source.Width, $source.Height)
      } finally { $graphics.Dispose() }
      $canvas.Save((Join-Path $faceDir $_.Name), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $canvas.Dispose() }
  } finally { $source.Dispose() }
}

$backWidth = 256
$backHeight = 352
$back = [System.Drawing.Bitmap]::new($backWidth, $backHeight, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
try {
  $graphics = [System.Drawing.Graphics]::FromImage($back)
  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $bounds = [System.Drawing.Rectangle]::new(0, 0, $backWidth, $backHeight)
    $base = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
      $bounds,
      [System.Drawing.Color]::FromArgb(255, 73, 91, 196),
      [System.Drawing.Color]::FromArgb(255, 228, 102, 176),
      55
    )
    try { $graphics.FillRectangle($base, $bounds) } finally { $base.Dispose() }

    $shade = [System.Drawing.Drawing2D.GraphicsPath]::new()
    try {
      $shade.AddEllipse(-60, -35, 255, 255)
      $glow = [System.Drawing.Drawing2D.PathGradientBrush]::new($shade)
      try {
        $glow.CenterColor = [System.Drawing.Color]::FromArgb(150, 210, 235, 255)
        $glow.SurroundColors = [System.Drawing.Color[]]@([System.Drawing.Color]::FromArgb(0, 95, 75, 198))
        $graphics.FillPath($glow, $shade)
      } finally { $glow.Dispose() }
    } finally { $shade.Dispose() }

    for ($i = -$backHeight; $i -lt $backWidth + $backHeight; $i += 34) {
      $stripe = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(20, 255, 255, 255), 10)
      try { $graphics.DrawLine($stripe, $i, 0, $i + $backHeight, $backHeight) } finally { $stripe.Dispose() }
    }

    $outer = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(220, 242, 224, 255), 5)
    $inner = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(180, 125, 231, 255), 2)
    try {
      $graphics.DrawRectangle($outer, 10, 10, $backWidth - 21, $backHeight - 21)
      $graphics.DrawRectangle($inner, 20, 20, $backWidth - 41, $backHeight - 41)
    } finally {
      $outer.Dispose()
      $inner.Dispose()
    }

    $ring1 = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(150, 255, 236, 181), 4)
    $ring2 = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(170, 205, 224, 255), 2)
    try {
      $graphics.DrawEllipse($ring1, 57, 105, 142, 142)
      $graphics.DrawEllipse($ring2, 70, 118, 116, 116)
    } finally {
      $ring1.Dispose()
      $ring2.Dispose()
    }

    Add-FourPointStar $graphics 128 176 48 ([System.Drawing.Color]::FromArgb(235, 255, 239, 170))
    Add-FourPointStar $graphics 128 176 29 ([System.Drawing.Color]::FromArgb(245, 179, 223, 255))
    Add-FourPointStar $graphics 38 50 10 ([System.Drawing.Color]::FromArgb(210, 255, 238, 179))
    Add-FourPointStar $graphics 218 302 9 ([System.Drawing.Color]::FromArgb(200, 194, 232, 255))
    Add-FourPointStar $graphics 218 54 6 ([System.Drawing.Color]::FromArgb(180, 255, 170, 221))
    Add-FourPointStar $graphics 40 300 6 ([System.Drawing.Color]::FromArgb(180, 167, 231, 255))
  } finally { $graphics.Dispose() }
  $back.Save((Join-Path $outputRoot 'tile-back.png'), [System.Drawing.Imaging.ImageFormat]::Png)
} finally { $back.Dispose() }

Write-Output "Generated llmAnime tile faces and tile back in $outputRoot"
