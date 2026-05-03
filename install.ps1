<#
.SYNOPSIS
  Papercup native Windows installer (PowerShell mirror of install.sh).

.DESCRIPTION
  Installs Papercup on Windows without WSL. Mirrors install.sh's flags and
  flow. Native-Windows-specific deltas:
    - MeloTTS install is skipped (MeCab / libssl don't ship cleanly on
      Windows). For Korean TTS on native Windows, pick TTS_ENGINE=xtts.
    - Daemon control via packages/bot/bin/papercup.ps1.
    - espeak-ng must be installed separately:
      https://github.com/espeak-ng/espeak-ng/releases

.EXAMPLE
  iwr -useb https://raw.githubusercontent.com/powder-nomad/papercup/main/install.ps1 | iex

.EXAMPLE
  # With flags — pass through environment variables OR re-run with explicit args:
  powershell -File install.ps1 -Agent claude-code -Tts xtts -Voice af_heart

.NOTES
  Korean TTS on native Windows requires TTS_ENGINE=xtts (the Coqui engine
  has Windows wheels). MeloTTS is unavailable. If you need MeloTTS,
  install via WSL2 instead.
#>
[CmdletBinding()]
param(
  [string]$Dir            = "$env:USERPROFILE\papercup",
  [string]$Branch         = "main",
  [string]$DiscordToken   = "",
  [string]$DiscordClientId= "",
  [string]$DiscordGuildId = "",

  [ValidateSet("claude-code","codex","anthropic-api")]
  [string]$Agent          = "claude-code",
  [string]$Model          = "haiku",
  [string]$AnthropicApiKey= "",

  [string]$Vad            = "silero",
  [ValidateSet("","whisper-base","whisper-base.en","whisper-small","whisper-small.en")]
  [string]$Stt            = "",
  [ValidateSet("kokoro","melotts","auto","xtts")]
  [string]$Tts            = "kokoro",   # native Windows default — no MeloTTS path
  [string]$Voice          = "af_heart",

  [int]$SilenceMs         = 600,
  [double]$VadThreshold   = 0.4,
  [int]$VadMinSpeechWindows = 3,

  [switch]$SkipModels,
  [switch]$SkipVenv,
  [switch]$SkipRegister,
  [switch]$NoStart,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/powder-nomad/papercup.git"

# ─── Pretty output ─────────────────────────────────────────────────────────
function Step($msg) { Write-Host "==> $msg" -ForegroundColor Blue }
function Ok($msg)   { Write-Host " ✓  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host " ⚠  $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host " ✗  $msg" -ForegroundColor Red; exit 1 }
function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Ask($prompt, $default = "") {
  if ($Yes) { return $default }
  $val = Read-Host "$prompt$($(if ($default) { " [$default]" } else { "" }))"
  if ([string]::IsNullOrWhiteSpace($val)) { return $default } else { return $val }
}

# ─── Sanity: dependencies ──────────────────────────────────────────────────
Step "Checking system dependencies"
if (-not (Have git))    { Die "git not installed (https://git-scm.com/download/win)" }
if (-not (Have node))   { Die "node not installed (need Node 20+; https://nodejs.org/)" }
if (-not (Have npm))    { Die "npm not installed (ships with Node)" }
if (-not (Have python)) { Die "python not installed (need 3.10+; https://www.python.org/downloads/windows/)" }

$nodeVersion = (node --version) -replace "^v",""
$nodeMajor = [int]($nodeVersion.Split(".")[0])
if ($nodeMajor -lt 20) { Die "Node 20+ required (got v$nodeVersion)" }

$pythonVersion = (python --version) -replace "^Python ",""
Ok "node v$nodeVersion, npm $(npm --version), python $pythonVersion"

if (-not (Have espeak-ng)) {
  Warn "espeak-ng not on PATH — Kokoro TTS will fail. Install: https://github.com/espeak-ng/espeak-ng/releases (run installer + add to PATH)"
}

if ($Tts -in @("melotts","auto")) {
  Warn "MeloTTS is not supported on native Windows (MeCab + libssl deps don't ship cleanly). Auto-switching to TTS=kokoro. For Korean TTS on Windows, re-run with: -Tts xtts"
  $Tts = "kokoro"
}

switch ($Agent) {
  "claude-code" {
    if (-not (Have claude)) { Warn "Agent=claude-code but 'claude' CLI not on PATH. Speaker won't respond until Claude Code is installed." }
  }
  "codex" {
    if (-not (Have codex)) { Warn "Agent=codex but 'codex' CLI not on PATH." }
  }
  "anthropic-api" {
    if ([string]::IsNullOrWhiteSpace($AnthropicApiKey)) { Warn "Agent=anthropic-api but no -AnthropicApiKey provided. Speaker won't respond until ANTHROPIC_API_KEY is set in .env." }
  }
}

# ─── Clone or update ───────────────────────────────────────────────────────
if (Test-Path "$Dir\.git") {
  Step "Updating existing install at $Dir"
  git -C $Dir fetch --depth 1 origin $Branch
  git -C $Dir checkout $Branch
  git -C $Dir reset --hard "origin/$Branch"
  Ok "git updated"
} else {
  Step "Cloning $RepoUrl → $Dir"
  git clone --depth 1 --branch $Branch $RepoUrl $Dir
  Ok "cloned"
}

Set-Location $Dir

# ─── Discord credentials ───────────────────────────────────────────────────
$EnvFile = "packages\bot\.env"
if (-not (Test-Path $EnvFile)) {
  Copy-Item "packages\bot\.env.example" $EnvFile
}

function Read-EnvVar($key) {
  if (-not (Test-Path $EnvFile)) { return "" }
  $line = Get-Content $EnvFile | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
  if ($line) { return ($line -replace "^$key=","") } else { return "" }
}

if (-not $DiscordToken)    { $DiscordToken    = Read-EnvVar "DISCORD_TOKEN" }
if (-not $DiscordClientId) { $DiscordClientId = Read-EnvVar "DISCORD_CLIENT_ID" }
if (-not $DiscordGuildId)  { $DiscordGuildId  = Read-EnvVar "DISCORD_GUILD_ID" }

if (-not $DiscordToken -or -not $DiscordClientId -or -not $DiscordGuildId) {
  Step "Discord credentials needed"
  Write-Host "  Bot token: dev portal → your app → Bot tab → Reset Token"
  Write-Host "  Client ID: dev portal → General Information"
  Write-Host "  Guild ID:  Discord client (Developer Mode on) → right-click server → Copy ID"
  Write-Host
  if (-not $DiscordToken)    { $DiscordToken    = Ask "DISCORD_TOKEN" }
  if (-not $DiscordClientId) { $DiscordClientId = Ask "DISCORD_CLIENT_ID" }
  if (-not $DiscordGuildId)  { $DiscordGuildId  = Ask "DISCORD_GUILD_ID" }
}

# ─── Default STT depends on TTS ────────────────────────────────────────────
if (-not $Stt) {
  $Stt = if ($Tts -in @("auto","melotts","xtts")) { "whisper-small" } else { "whisper-base" }
}

$WhisperModel = switch ($Stt) {
  "whisper-base.en"  { "base.en" }
  "whisper-base"     { "base" }
  "whisper-small.en" { "small.en" }
  "whisper-small"    { "small" }
  default            { $Stt -replace "^whisper-","" }
}

# ─── Write .env (replace each line in place) ───────────────────────────────
Step "Writing $EnvFile"
function Write-EnvVar($key, $val) {
  $lines = if (Test-Path $EnvFile) { Get-Content $EnvFile } else { @() }
  $found = $false
  $out = foreach ($line in $lines) {
    if ($line -match "^$key=") { $found = $true; "$key=$val" } else { $line }
  }
  if (-not $found) { $out += "$key=$val" }
  Set-Content -Path $EnvFile -Value $out -Encoding UTF8
}

Write-EnvVar "DISCORD_TOKEN"     $DiscordToken
Write-EnvVar "DISCORD_CLIENT_ID" $DiscordClientId
Write-EnvVar "DISCORD_GUILD_ID"  $DiscordGuildId
Write-EnvVar "SILENCE_MS"        $SilenceMs
Write-EnvVar "VAD_THRESHOLD"     $VadThreshold
Write-EnvVar "VAD_MIN_SPEECH_WINDOWS" $VadMinSpeechWindows
Write-EnvVar "WHISPER_MODEL"     $WhisperModel
Write-EnvVar "TTS_ENGINE"        $Tts
Write-EnvVar "KOKORO_VOICE"      $Voice
Write-EnvVar "AGENT_BACKEND"     $Agent
Write-EnvVar "AGENT_MODEL"       $Model
if ($AnthropicApiKey) { Write-EnvVar "ANTHROPIC_API_KEY" $AnthropicApiKey }
Ok ".env written"

# ─── Node deps ─────────────────────────────────────────────────────────────
Step "Installing Node deps (npm install — may take a minute on cold cache)"
npm install --silent | Select-Object -Last 3
if ($LASTEXITCODE -ne 0) { Die "npm install failed" }
Ok "node_modules ready"

# ─── Python venv ───────────────────────────────────────────────────────────
if (-not $SkipVenv) {
  $VenvDir = "packages\voice-stack\sidecar\.venv"
  $VenvPython = "$VenvDir\Scripts\python.exe"
  if (-not (Test-Path $VenvPython)) {
    Step "Creating Python venv at $VenvDir (slow step — ~700MB of wheels)"
    python -m venv $VenvDir
    & "$VenvDir\Scripts\python.exe" -m pip install --upgrade --quiet pip
    & "$VenvDir\Scripts\python.exe" -m pip install --quiet -r packages\voice-stack\sidecar\requirements.txt
    Ok "venv installed"
  } else {
    Ok "venv already exists at $VenvDir"
  }

  # XTTS install path — Coqui wheels work on Windows. Run when TTS_ENGINE=xtts.
  if ($Tts -eq "xtts") {
    $hasXtts = $false
    & $VenvPython -c "import TTS.api" 2>$null
    if ($LASTEXITCODE -eq 0) { $hasXtts = $true }
    if ($hasXtts) {
      Ok "coqui-tts (XTTS-v2) already installed"
    } else {
      Step "Installing Coqui TTS (XTTS-v2 engine) — adds ~1GB to venv"
      & $VenvPython -m pip install --no-cache-dir coqui-tts
      & $VenvPython -m pip install --no-cache-dir "transformers>=4.46,<5"
      if ($LASTEXITCODE -ne 0) { Die "coqui-tts install failed" }
      Ok "coqui-tts installed"
    }
  }
}

# ─── Models ────────────────────────────────────────────────────────────────
if (-not $SkipModels) {
  Step "Downloading voice models (~355MB total)"
  & powershell -File "packages\voice-stack\scripts\download-models.ps1"
  if ($LASTEXITCODE -ne 0) { Die "model download failed" }
  Ok "models ready"
}

# ─── Register slash commands ───────────────────────────────────────────────
if (-not $SkipRegister) {
  Step "Registering slash commands"
  npm run register --workspace=@papercup/bot --silent | Select-Object -Last 3
  Ok "slash commands pushed to Discord"
}

# ─── Capability summary ────────────────────────────────────────────────────
Write-Host
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host " Papercup install complete (native Windows)" -ForegroundColor Green
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host
Write-Host "  Install dir     $Dir"
Write-Host "  VAD             $Vad"
$isEnglishOnly = $WhisperModel -like "*.en"
Write-Host "  STT             $Stt ($WhisperModel, English-only? $isEnglishOnly)"
Write-Host "  TTS             $Tts (voice: $Voice)"
Write-Host "  Agent backend   $Agent (model: $Model)"
Write-Host
Write-Host "Capabilities matrix:"
if ($isEnglishOnly) {
  Write-Host "  STT: English only" -ForegroundColor Yellow
} else {
  Write-Host "  STT: multilingual (Whisper auto-detects 99 langs incl. Korean)" -ForegroundColor Green
}
switch ($Tts) {
  "kokoro" { Write-Host "  TTS: en/ja/zh/es/fr/hi/it/pt only (Kokoro — no Korean)" -ForegroundColor Yellow }
  "xtts"   { Write-Host "  TTS: 17 languages incl. Korean (XTTS-v2; ~58 built-in speakers)" -ForegroundColor Green }
}
Write-Host

# ─── Start daemon ──────────────────────────────────────────────────────────
if (-not $NoStart) {
  Step "Starting bot"
  & powershell -File "packages\bot\bin\papercup.ps1" start
  Write-Host
  Write-Host "Tail logs:   powershell -File $Dir\packages\bot\bin\papercup.ps1 logs"
  Write-Host "Stop bot:    powershell -File $Dir\packages\bot\bin\papercup.ps1 stop"
  Write-Host "Status:      powershell -File $Dir\packages\bot\bin\papercup.ps1 status"
} else {
  Write-Host "Skipped daemon start (-NoStart). Launch with:"
  Write-Host "  powershell -File $Dir\packages\bot\bin\papercup.ps1 start"
}

Write-Host
Ok "Done."
