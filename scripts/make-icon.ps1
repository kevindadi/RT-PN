# Generate the RT-PN source icon (1024x1024 PNG) with System.Drawing.
#
# The generated PNG is the input for `tauri icon`, which writes the per-size
# .ico/.icns/.png set into src-tauri/icons/:
#
#   powershell -NoProfile -File scripts/make-icon.ps1
#   npm run tauri -- icon src-tauri/icons/icon.png
#
# Run from the repository root.

param(
    [string]$Out = "src-tauri/icons/icon.png"
)

Add-Type -AssemblyName System.Drawing

$size = 1024
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

# Dark workbench background with a subtle accent ring.
$background = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(20, 23, 32))
$g.FillRectangle($background, 0, 0, $size, $size)

$accent = [System.Drawing.Color]::FromArgb(79, 163, 255)
$ringPen = New-Object System.Drawing.Pen ($accent, 24)
$g.DrawEllipse($ringPen, 88, 88, 848, 848)

# Petri-net motif: three places (circles) around one transition (bar).
$placeBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(240, 246, 255))
$arcPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(150, 205, 255), 18)
$barPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(79, 163, 255), 34)

$g.DrawLine($arcPen, 372, 392, 472, 268)
$g.DrawLine($arcPen, 652, 392, 552, 268)
$g.DrawLine($arcPen, 372, 472, 512, 566)
$g.DrawLine($arcPen, 652, 472, 512, 566)

$g.DrawLine($barPen, 512, 250, 512, 330)

$g.FillEllipse($placeBrush, 318, 128, 108, 108)
$g.FillEllipse($placeBrush, 598, 128, 108, 108)
$g.FillEllipse($placeBrush, 458, 566, 108, 108)

# Wordmark.
$textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(240, 246, 255))
$font = New-Object System.Drawing.Font "Segoe UI", 132, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$text = "RT-PN"
$textSize = $g.MeasureString($text, $font)
$textX = [int](($size - $textSize.Width) / 2)
$g.DrawString($text, $font, $textBrush, $textX, 700)

$directory = Split-Path -Parent $Out
if ($directory -and -not (Test-Path $directory)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}
$bmp.Save((Join-Path (Get-Location) $Out), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()

Write-Host "wrote $Out"
