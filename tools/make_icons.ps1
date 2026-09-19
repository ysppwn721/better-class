/* ============================================================================
 * tools/make_icons.ps1 — 生成 Android 位图启动图标（mipmap-*）
 * 自适应图标（v26+）走矢量，这里只是给 Android 7 及以下兜底。
 * 用法：powershell -File tools/make_icons.ps1
 * ==========================================================================*/
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$res  = Join-Path $root 'android\app\src\main\res'

# density → 边长（px），按 Android 图标规范
$sizes = @{
  'mipmap-mdpi'    = 48
  'mipmap-hdpi'    = 72
  'mipmap-xhdpi'   = 96
  'mipmap-xxhdpi'  = 144
  'mipmap-xxxhdpi' = 192
}

function New-Icon([int]$S, [string]$Out) {
  $bmp = New-Object System.Drawing.Bitmap($S, $S)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D]::SmoothingMode::AntiAlias

  # 圆角矩形路径（透明度 0 的角用于圆角效果）
  $r = [Math]::Max(2, [int]($S * 0.22))
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($S - $d - 1, 0, $d, $d, 270, 90)
  $path.AddArc($S - $d - 1, $S - $d - 1, $d, $d, 0, 90)
  $path.AddArc(0, $S - $d - 1, $d, $d, 90, 90)
  $path.CloseFigure()

  # 渐变底
  $rect = New-Object System.Drawing.Rectangle(0, 0, $S, $S)
  $lg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 59, 107, 255),
    [System.Drawing.Color]::FromArgb(255, 139, 92, 255),
    45.0)
  $g.FillPath($lg, $path)

  # 白色日历卡片
  $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
  $cw = [int]($S * 0.56); $ch = [int]($S * 0.50)
  $cx = [int](($S - $cw) / 2); $cy = [int](($S - $ch) / 2) + [int]($S * 0.03)
  $pad = [Math]::Max(1, [int]($S * 0.03))
  $g.FillRectangle($white, $cx, $cy, $cw, $ch)

  # 三个课程格
  $blue = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 78, 123, 255))
  $gw = [int]($cw * 0.22); $gh = [int]($ch * 0.28)
  $gapx = [int]($cw * 0.10)
  for ($i = 0; $i -lt 3; $i++) {
    $gx = $cx + $pad + $i * ($gw + $gapx)
    $g.FillRectangle($blue, $gx, $cy + [int]($ch * 0.34), $gw, $gh)
  }

  # 顶部色带与挂环
  $g.FillRectangle($white, $cx, $cy, $cw, [int]($ch * 0.20))
  $g.FillRectangle($white, $cx + [int]($cw * 0.18), $cy - [int]($S * 0.06), [int]($cw * 0.12), [int]($S * 0.12))
  $g.FillRectangle($white, $cx + [int]($cw * 0.70), $cy - [int]($S * 0.06), [int]($cw * 0.12), [int]($S * 0.12))

  $g.Dispose()
  $dir = Split-Path -Parent $Out
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

foreach ($k in $sizes.Keys) {
  $s = $sizes[$k]
  New-Icon $s (Join-Path $res "$k\ic_launcher.png")
  New-Icon $s (Join-Path $res "$k\ic_launcher_round.png")
  Write-Host "  ✓ $k  ${s}x${s}"
}
Write-Host "图标生成完成 → android/app/src/main/res/mipmap-*"
