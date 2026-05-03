# Windows 설치

두 가지 경로. 완전한 기능 (한국어 MeloTTS 포함)을 위해서는 WSL2가 권장됩니다. 네이티브 Windows도 몇 가지 제약과 함께 동작합니다.

## 경로 1: WSL2 (권장)

기존 `install.sh`가 WSL2 안에서 그대로 동작합니다.

1. **WSL2 설치** (없는 경우):
   ```powershell
   wsl --install
   ```
   기본으로 Ubuntu가 설치됩니다. 안내가 나오면 재부팅하세요.

2. **Ubuntu 셸**을 열고 사전 요구사항 설치:
   ```sh
   sudo apt-get update
   sudo apt-get install -y git curl espeak-ng python3-venv build-essential python3-dev nodejs npm
   # 한국어 / MeloTTS가 필요한 경우:
   sudo apt-get install -y libmecab-dev mecab-ipadic-utf8 libssl-dev pkg-config
   ```

3. **Node 20+** 설치 (Ubuntu 기본 버전은 너무 오래됨):
   ```sh
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

4. Linux와 동일하게 **원라이너 실행**:
   ```sh
   bash <(curl -fsSL https://raw.githubusercontent.com/powder-nomad/papercup/main/install.sh)
   ```

5. **WSL2의 Discord 음성** — 정상 동작합니다. WSL2는 전체 네트워크 스택에 접근 가능.

## 경로 2: 네이티브 Windows (PowerShell)

WSL2를 사용할 수 없을 때. 제약사항:

- **MeloTTS는 네이티브 Windows에서 사용 불가** — MeCab + libssl 의존성이 깨끗하게 설치되지 않음. PowerShell 설치 스크립트는 `melotts`/`auto`를 요청하면 자동으로 `kokoro`로 전환합니다.
- **한국어 TTS는 여전히 동작** — `-Tts xtts` 옵션 사용 (Coqui XTTS-v2는 Windows 휠 제공). XTTS는 ~58개 내장 스피커 + 6초 클립으로부터 음성 복제 기능을 제공.

### 사전 요구사항

수동으로 설치:

| 패키지 | 위치 |
| --- | --- |
| Git for Windows | https://git-scm.com/download/win |
| Node.js LTS (20+) | https://nodejs.org/ — LTS Windows 설치 프로그램 선택 |
| Python 3.10+ | https://www.python.org/downloads/windows/ — 설치 시 **"Add to PATH" 체크** |
| espeak-ng | https://github.com/espeak-ng/espeak-ng/releases — 설치 + PATH 추가 |
| Visual Studio Build Tools | https://visualstudio.microsoft.com/visual-cpp-build-tools/ — `onnxruntime-node` 네이티브 빌드 시 필요 |

### 원라이너 설치

**관리자 PowerShell**에서 (우클릭 → 관리자 권한으로 실행):

```powershell
iwr -useb https://raw.githubusercontent.com/powder-nomad/papercup/main/install.ps1 | iex
```

실행 정책이 차단하면, 이 세션에 대해 허용:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
iwr -useb https://raw.githubusercontent.com/powder-nomad/papercup/main/install.ps1 | iex
```

### 플래그 사용

```powershell
# 한 번 다운로드 후 사용자 정의 플래그로 실행
iwr -OutFile install.ps1 https://raw.githubusercontent.com/powder-nomad/papercup/main/install.ps1
powershell -File install.ps1 -Agent claude-code -Tts xtts -Voice af_heart
```

전체 플래그 (install.sh 미러):

```
-Dir <path>             설치 위치. 기본값: %USERPROFILE%\papercup
-Branch <name>          Git 브랜치. 기본값: main
-DiscordToken <token>   봇 토큰 (없으면 프롬프트)
-DiscordClientId <id>
-DiscordGuildId <id>

-Agent <name>           claude-code (기본) | codex | anthropic-api
-Model <name>           haiku (기본), sonnet, opus, gpt-5 등
-AnthropicApiKey <k>    -Agent anthropic-api일 때만 필요

-Vad <name>             silero (기본; 현재 유일한 옵션)
-Stt <name>             whisper-base (기본) | whisper-small |
                        whisper-base.en | whisper-small.en
-Tts <name>             kokoro (기본) | xtts (한국어 + 음성 복제)
-Voice <name>           Kokoro 보이스. 기본값: af_heart

-SilenceMs <int>        발화 종료 무음 (ms). 기본값: 600
-VadThreshold <float>   음성 확률 임계값. 기본값: 0.4

-SkipModels             음성 모델 다운로드 건너뛰기
-SkipVenv               Python venv 생성 건너뛰기
-SkipRegister           Discord에 슬래시 명령 푸시 건너뛰기
-NoStart                설치만; 데몬 시작 안 함
-Yes                    모든 기본값 수락; 프롬프트 없음
```

### 데몬 제어

설치 후, PowerShell에서 봇 관리:

```powershell
$papercup = "$env:USERPROFILE\papercup\packages\bot\bin\papercup.ps1"

powershell -File $papercup status
powershell -File $papercup start
powershell -File $papercup stop
powershell -File $papercup restart
powershell -File $papercup logs    # Get-Content -Wait
powershell -File $papercup tail 50
```

### 일반적인 Windows 함정

- **`npm install`에서 `onnxruntime-node` 네이티브 의존성 실패** — Visual Studio Build Tools 설치 후 설치 스크립트 재실행.
- **`espeak-ng`가 PATH에 없음** — 설치 프로그램 실행 후 재부팅하거나 `setx PATH "$env:PATH;C:\Program Files\eSpeak NG"` 실행 후 새 셸 열기.
- **"스크립트 실행이 비활성화됨" PowerShell 오류** — `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (1회, 영구).
- **Discord 음성이 끊어짐 / 오디오 없음** — Windows의 기본 오디오 향상이 패킷에 영향을 줄 수 있음. 사운드 설정 → 장치 속성 → 추가 장치 속성 → 향상 → 마이크 입력에서 "모든 향상 사용 안 함" 체크.
- **봇이 시작 시 자동 종료** — `%USERPROFILE%\papercup\packages\bot\logs\bot.log.err` 확인 (PowerShell `Start-Process`는 stderr를 별도 파일에 기록).
