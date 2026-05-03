# Windows install

Two paths. WSL2 is the recommended one for full feature parity (including Korean MeloTTS); native Windows works with a couple of caveats.

## Path 1: WSL2 (recommended)

The Linux installer just works inside WSL2 — the existing `install.sh` runs as-is.

1. **Install WSL2** if you don't have it:
   ```powershell
   wsl --install
   ```
   This installs Ubuntu by default. Reboot if prompted.

2. **Open the Ubuntu shell** and install prereqs:
   ```sh
   sudo apt-get update
   sudo apt-get install -y git curl espeak-ng python3-venv build-essential python3-dev nodejs npm
   # If you want Korean / MeloTTS:
   sudo apt-get install -y libmecab-dev mecab-ipadic-utf8 libssl-dev pkg-config
   ```

3. **Install Node 20+** (Ubuntu's default is too old):
   ```sh
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

4. **Run the one-liner** as you would on Linux:
   ```sh
   bash <(curl -fsSL https://raw.githubusercontent.com/powder-nomad/papercup/main/install.sh)
   ```

5. **Discord voice from WSL2** — works fine. WSL2 has full network stack access.

## Path 2: Native Windows (PowerShell)

For when WSL2 isn't an option. Caveats:

- **MeloTTS is not available** on native Windows — its MeCab + libssl deps don't ship cleanly. The PowerShell installer auto-switches to `kokoro` if you ask for `melotts`/`auto`.
- **Korean TTS still works** via `-Tts xtts` (Coqui XTTS-v2 has Windows wheels). XTTS gives you ~58 built-in speakers + voice cloning from a 6-second clip.

### Prereqs

Install these manually:

| Package | Where |
| --- | --- |
| Git for Windows | https://git-scm.com/download/win |
| Node.js LTS (20+) | https://nodejs.org/ — pick the LTS Windows installer |
| Python 3.10+ | https://www.python.org/downloads/windows/ — **check "Add to PATH"** during install |
| espeak-ng | https://github.com/espeak-ng/espeak-ng/releases — run installer + add to PATH |
| Visual Studio Build Tools | https://visualstudio.microsoft.com/visual-cpp-build-tools/ — needed for `onnxruntime-node` native deps if pre-built fails |

### One-liner installer

In an **Administrator PowerShell** (right-click → Run as Administrator):

```powershell
iwr -useb https://raw.githubusercontent.com/powder-nomad/papercup/main/install.ps1 | iex
```

If your execution policy blocks the IEX, allow it for this session:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
iwr -useb https://raw.githubusercontent.com/powder-nomad/papercup/main/install.ps1 | iex
```

### With flags

```powershell
# Download once, run with custom flags
iwr -OutFile install.ps1 https://raw.githubusercontent.com/powder-nomad/papercup/main/install.ps1
powershell -File install.ps1 -Agent claude-code -Tts xtts -Voice af_heart
```

All flags (mirror of install.sh):

```
-Dir <path>             Install location. Default: %USERPROFILE%\papercup
-Branch <name>          Git branch. Default: main
-DiscordToken <token>   Bot token (otherwise prompted)
-DiscordClientId <id>
-DiscordGuildId <id>

-Agent <name>           claude-code (default) | codex | anthropic-api
-Model <name>           haiku (default), sonnet, opus, gpt-5, etc.
-AnthropicApiKey <k>    Required only if -Agent anthropic-api

-Vad <name>             silero (default; only option today)
-Stt <name>             whisper-base (default) | whisper-small |
                        whisper-base.en | whisper-small.en
-Tts <name>             kokoro (default) | xtts (Korean + voice cloning)
-Voice <name>           Kokoro voice. Default: af_heart

-SilenceMs <int>        End-of-utterance silence (ms). Default: 600
-VadThreshold <float>   Speech probability threshold. Default: 0.4

-SkipModels             Don't download voice models
-SkipVenv               Don't create the Python venv
-SkipRegister           Don't push slash commands to Discord
-NoStart                Install only; don't start the daemon
-Yes                    Accept all defaults; never prompt
```

### Daemon control

After install, manage the bot from PowerShell:

```powershell
# All commands run from anywhere
$papercup = "$env:USERPROFILE\papercup\packages\bot\bin\papercup.ps1"

powershell -File $papercup status
powershell -File $papercup start
powershell -File $papercup stop
powershell -File $papercup restart
powershell -File $papercup logs    # Get-Content -Wait
powershell -File $papercup tail 50
```

Or `cd %USERPROFILE%\papercup\packages\bot\bin` and call `.\papercup.ps1 <command>` directly.

### Common Windows gotchas

- **`onnxruntime-node` native dep fails on `npm install`** — install Visual Studio Build Tools (link above) and re-run the installer.
- **`espeak-ng not on PATH`** — run the installer, then either reboot or run `setx PATH "$env:PATH;C:\Program Files\eSpeak NG"` and open a new shell.
- **"running scripts is disabled" on PowerShell** — `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (one-time, persistent).
- **Discord voice cuts out / no audio** — Windows defaults often add audio enhancements that mess with packets. In Sound Settings → Device properties → Additional device properties → Enhancements → check "Disable all enhancements" for the input mic.
- **Bot silently dies on startup** — check `%USERPROFILE%\papercup\packages\bot\logs\bot.log.err` (PowerShell `Start-Process` writes stderr to a separate file).
