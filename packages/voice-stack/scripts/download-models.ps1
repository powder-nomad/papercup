<#
.SYNOPSIS
  Download local ML models needed by Papercup (Windows mirror of download-models.sh).

.DESCRIPTION
  Idempotent — skips existing files. Pulls Silero VAD + Kokoro TTS model + voices.
  Whisper (faster-whisper) auto-downloads its own model on first STT call.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$VoiceStackRoot = Split-Path -Parent $ScriptDir
$ModelsDir = Join-Path $VoiceStackRoot "models"

if (-not (Test-Path $ModelsDir)) { New-Item -ItemType Directory -Path $ModelsDir | Out-Null }

function Fetch-Model($url, $path, $name) {
  if (Test-Path $path) {
    $size = (Get-Item $path).Length
    Write-Host "$name already present ($size bytes)"
    return
  }
  Write-Host "Downloading $name…"
  Invoke-WebRequest -Uri $url -OutFile $path -UseBasicParsing
  $size = (Get-Item $path).Length
  Write-Host "  → $path ($size bytes)"
}

Fetch-Model `
  "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx" `
  (Join-Path $ModelsDir "silero_vad.onnx") `
  "silero_vad.onnx"

Fetch-Model `
  "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx" `
  (Join-Path $ModelsDir "kokoro-v1.0.onnx") `
  "kokoro-v1.0.onnx"

Fetch-Model `
  "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin" `
  (Join-Path $ModelsDir "kokoro-voices-v1.0.bin") `
  "kokoro-voices-v1.0.bin"
