# Windows.Media.Ocr 한국어 OCR. 사용법: powershell -NoProfile -ExecutionPolicy Bypass -File win-ocr.ps1 <이미지>...
# 출력: [{"file","width","height","lines":[{"text","x","y","w","h","conf"}],"error"}]  (vision-ocr와 같은 형식)
# 종료 코드 3: 한국어 OCR 언어 팩 미설치
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Files)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, [Type]$type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait() | Out-Null
  $task.Result
}

$lang = New-Object Windows.Globalization.Language 'ko'
if (-not [Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($lang)) {
  [Console]::Error.WriteLine('korean_unsupported')
  exit 3
}
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)

$pages = @()
foreach ($f in $Files) {
  try {
    $full = (Resolve-Path -LiteralPath $f).Path
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = @()
    foreach ($line in $result.Lines) {
      $xs = $line.Words | ForEach-Object { $_.BoundingRect }
      $x0 = ($xs | Measure-Object -Property X -Minimum).Minimum
      $y0 = ($xs | Measure-Object -Property Y -Minimum).Minimum
      $x1 = ($xs | ForEach-Object { $_.X + $_.Width } | Measure-Object -Maximum).Maximum
      $y1 = ($xs | ForEach-Object { $_.Y + $_.Height } | Measure-Object -Maximum).Maximum
      # 한국어 OCR은 글자 사이에 공백을 넣는 경우가 많아 단어를 붙여서 돌려준다(띄어쓰기는 후처리에서 판단)
      $text = ($line.Words | ForEach-Object { $_.Text }) -join ' '
      $lines += [ordered]@{ text = $text; x = [int]$x0; y = [int]$y0; w = [int]($x1 - $x0); h = [int]($y1 - $y0); conf = 1.0 }
    }
    $pages += [ordered]@{ file = $f; width = [int]$bitmap.PixelWidth; height = [int]$bitmap.PixelHeight; lines = $lines; error = $null }
    $stream.Dispose()
  } catch {
    $pages += [ordered]@{ file = $f; width = 0; height = 0; lines = @(); error = "ocr_failed: $($_.Exception.Message)" }
  }
}
ConvertTo-Json -InputObject @($pages) -Depth 6 -Compress
