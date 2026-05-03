---
title: Korean (and other non-Kokoro languages)
---

# Korean

Papercup speaks Korean end-to-end as of v0.2. The pipeline is the same as English, with two adjustments:

## STT: multilingual Whisper

Default model is now `WHISPER_MODEL=base` (multilingual). Whisper auto-detects the input language per utterance and returns it via `transcript.lang`. No config needed beyond defaulting to `base` instead of `base.en`.

`base` is slightly slower than `base.en` (~0.4 RTF vs 0.3 on a 4-core CPU) but accurate enough for Korean. Bump to `WHISPER_MODEL=small` if accuracy matters; `small.en` is English-only and faster.

## TTS: MeloTTS or XTTS-v2 (Kokoro doesn't ship Korean)

Kokoro v1.0 supports 9 languages — Korean isn't one of them. Two Korean engines ship:

| Engine | Voices | RTF (4-core CPU) | RAM | Tradeoff |
| --- | --- | --- | --- | --- |
| **MeloTTS** | 1 (monotone) | ~2.3× | ~1.5 GB | Lighter, faster, but the voice sounds news-anchor-flat |
| **XTTS-v2** | ~58 built-in + voice cloning from a 6s clip | ~3× | ~3 GB | Heavier, slower, expressive — real choice over voices |

The recommended `TTS_ENGINE=auto` configuration runs both Kokoro and your chosen Korean engine, routing per-utterance based on Whisper's detected language:

| Detected language | Engine |
| --- | --- |
| `ko` | MeloTTS or XTTS (picked via `TTS_KO_ENGINE=melotts\|xtts`) |
| everything else | Kokoro |

The Korean engine **pre-warms in the background by default** (`MELOTTS_PREWARM=1` / `XTTS_PREWARM=1`) so the first KR call doesn't pay the model load. Set `MELOTTS_PREWARM=0` / `XTTS_PREWARM=0` if you want lazy boot instead.

Pre-warmed boot times: MeloTTS ~17s, XTTS ~30s. Lazy first-call boot is the same numbers, just paid mid-conversation.

## Agent: matches user's language

The speaker agent's system prompt instructs it to reply in whatever language the user spoke. So Korean input → Korean reply → MeloTTS speaks Korean back. No translation step.

## Install prereqs

MeloTTS pulls in PyTorch (~700MB) and uses MeCab for Japanese tokenization. Even when only synthesizing Korean, the install needs a few system libs:

```sh
# Linux
sudo apt-get install -y libmecab-dev mecab-ipadic-utf8 libssl-dev pkg-config

# macOS
brew install mecab mecab-ipadic openssl pkg-config
```

Then either run `install.sh` with default `--tts auto` (which auto-runs the MeloTTS install helper), or upgrade an existing install:

```sh
cd ~/papercup
bash packages/voice-stack/sidecar/install-melotts.sh packages/voice-stack/sidecar/.venv
# Edit packages/bot/.env: TTS_ENGINE=auto, WHISPER_MODEL=base
bash packages/bot/bin/papercup restart
```

The helper handles a stack of upstream pin issues for you:

- **MeloTTS pins old transformers** (4.27.4) → forces tokenizers 0.13.x → no cp312 wheel → broken Rust source build. Helper clones MeloTTS, unpins to `transformers>=4.36.0` (only stable APIs are used).
- **transformers requires torch ≥ 2.6** ([CVE-2025-32434](https://nvd.nist.gov/vuln/detail/CVE-2025-32434)). Helper pre-installs `torch==2.6.0+cpu` from PyTorch's CPU wheel index — otherwise pip drags in ~3 GB of CUDA wheels you don't need.
- **librosa 0.9.1** uses removed `pkg_resources` from setuptools 81+. Helper bumps to `librosa>=0.10`.
- **jieba/pykakasi** still need `pkg_resources` though. Helper pins `setuptools<81`.
- **unidic Japanese dict** is not auto-downloaded by the wheel. Helper runs `python -m unidic download` (~250 MB) so MeloTTS's eager Japanese imports don't crash even for KR-only sessions.

## Limitations

- **Voice quality.** MeloTTS Korean is good — natural prosody, single voice. If you want a Korean speaker with multiple voice options, we'd need a different engine (Coqui XTTS-v2, MOSS-TTS-Nano with reference clips). Not built today.
- **Boot time.** First Korean utterance takes ~30-60s as MeloTTS loads PyTorch + downloads Korean BERT (~500MB). One-time cost per bot run.
- **Mid-conversation language switch.** If you speak English then Korean, the bot routes correctly per turn — no extra config. But the agent's history is single-track, so it'll see "EN: hello / KO: 안녕" interleaved. That's fine; LLMs handle it natively.

## Other languages

`TTS_ENGINE=auto` covers Korean specifically (`ko` → MeloTTS). Other languages route to Kokoro. To use MeloTTS for, say, Spanish or French instead of Kokoro:

```env
TTS_ENGINE=melotts
MELOTTS_LANG=ES   # or FR, JP, ZH, EN
```

This pins the bot to one MeloTTS language model — no auto-routing, no Kokoro. Typically you want `auto` instead.
