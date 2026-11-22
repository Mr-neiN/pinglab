<#
  Draws PingLab's icon (dark tile, cyan latency trace) and writes installer\pinglab.ico.
  Each size is stored as a classic 32-bit DIB entry rather than a PNG, because Windows and
  .NET both read those without surprises. The result is committed, so releasing does not
  need to run this.
#>
Add-Type -AssemblyName System.Drawing

$output = Join-Path $PSScriptRoot "pinglab.ico"
$sizes = @(256, 64, 48, 32, 16)

function New-IconBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $radius = [int]($size * 0.22)
    $edge = $radius * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $edge, $edge, 180, 90)
    $path.AddArc($size - $edge, 0, $edge, $edge, 270, 90)
    $path.AddArc($size - $edge, $size - $edge, $edge, $edge, 0, 90)
    $path.AddArc(0, $size - $edge, $edge, $edge, 90, 90)
    $path.CloseFigure()
    $tile = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 15, 23, 42))
    $g.FillPath($tile, $path)

    $trace = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 34, 211, 238)), ([single]($size * 0.075))
    $trace.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $trace.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $trace.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $points = @(
        (New-Object System.Drawing.PointF ([single]($size * 0.17), [single]($size * 0.55))),
        (New-Object System.Drawing.PointF ([single]($size * 0.34), [single]($size * 0.55))),
        (New-Object System.Drawing.PointF ([single]($size * 0.44), [single]($size * 0.30))),
        (New-Object System.Drawing.PointF ([single]($size * 0.56), [single]($size * 0.74))),
        (New-Object System.Drawing.PointF ([single]($size * 0.66), [single]($size * 0.48))),
        (New-Object System.Drawing.PointF ([single]($size * 0.83), [single]($size * 0.48)))
    )
    $g.DrawLines($trace, [System.Drawing.PointF[]]$points)

    $g.Dispose()
    $tile.Dispose()
    $trace.Dispose()
    return $bmp
}

function Get-IconDib([System.Drawing.Bitmap]$bmp) {
    $size = $bmp.Width
    $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
    $locked = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = $locked.Stride
    $pixels = New-Object byte[] ($stride * $size)
    [System.Runtime.InteropServices.Marshal]::Copy($locked.Scan0, $pixels, 0, $pixels.Length)
    $bmp.UnlockBits($locked)

    $stream = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter $stream
    # BITMAPINFOHEADER: height is doubled because the image is followed by an AND mask.
    $writer.Write([int]40)
    $writer.Write([int]$size)
    $writer.Write([int]($size * 2))
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([int]0)
    $writer.Write([int]($stride * $size))
    $writer.Write([int]0)
    $writer.Write([int]0)
    $writer.Write([int]0)
    $writer.Write([int]0)
    for ($y = $size - 1; $y -ge 0; $y--) {
        $writer.Write($pixels, $y * $stride, $stride)
    }
    $maskStride = [int]([math]::Ceiling($size / 32.0) * 4)
    $mask = New-Object byte[] ($maskStride * $size)
    $writer.Write($mask, 0, $mask.Length)
    $writer.Flush()
    $bytes = $stream.ToArray()
    $writer.Dispose()
    $stream.Dispose()
    return , $bytes
}

$images = @()
foreach ($size in $sizes) {
    $bmp = New-IconBitmap $size
    $images += , @($size, (Get-IconDib $bmp))
    $bmp.Dispose()
}

$file = [System.IO.File]::Create($output)
$writer = New-Object System.IO.BinaryWriter $file
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($image in $images) {
    $size = $image[0]
    $data = $image[1]
    $dimension = if ($size -ge 256) { 0 } else { $size }
    $writer.Write([byte]$dimension)
    $writer.Write([byte]$dimension)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$data.Length)
    $writer.Write([uint32]$offset)
    $offset += $data.Length
}
foreach ($image in $images) { $writer.Write([byte[]]$image[1]) }
$writer.Flush()
$writer.Dispose()
$file.Dispose()

Write-Host "wrote $output ($((Get-Item $output).Length) bytes, sizes: $($sizes -join ', '))"
