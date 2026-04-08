# Dictation / ASR

Oppi's dictation pipeline transcribes voice input from the iOS app. Two
paths are available: on-device (Apple's built-in recognizer) and server
(streaming ASR through the Oppi server). Both are transparent to the
user — audio goes in, text comes out.

## On-Device vs Server

| | On-device | Server |
|---|---|---|
| Engine | Apple SFSpeechRecognizer / system dictation | Any OpenAI-compatible `/v1/audio/transcriptions` endpoint |
| Latency | Real-time | ~138ms per 2s chunk (MLX, M3 Ultra) |
| Privacy | Apple's terms | Fully private (runs on your hardware) |
| Languages | System locale only | Bilingual EN/ZH with code-switching (Qwen3-ASR) |
| Config needed | None | `asr.sttEndpoint` in server config |

### iOS Settings (Settings > Voice Input > Dictation Engine)

- **Automatic** — uses server dictation when connected, falls back to on-device
- **On-device** — Apple's built-in dictation only
- **Server** — always route through the Oppi server

When using server dictation, the mic button shows a cloud icon instead of
the language label (EN/中), since the model detects language automatically.

## Architecture (Server Mode)

```
iPhone (mic) → WebSocket /stream → Oppi Server → STT endpoint → text
                  (unified WS)                    ↓
                                               FLAC archive
```

Dictation shares the same `/stream` WebSocket used for session events.
The server distinguishes dictation traffic by message type.

1. iOS sends a `dictation_start` message, then streams raw PCM audio
   (16kHz, 16-bit, mono) as binary frames over `/stream`.
2. The server creates a stateful streaming session on the STT backend.
3. Audio is fed in ~2s chunks; each returns an updated transcript.
4. Interim results stream back to the phone (typewriter animation).
5. On `dictation_stop`, the server gets final text, optionally runs LLM
   correction, and saves the audio as FLAC.

### STT Backend

The server talks to any endpoint that implements the streaming session API:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/audio/transcriptions/stream` | Create session (JSON body: `{ model, stream_config? }`) |
| `POST` | `/v1/audio/transcriptions/stream/:id` | Feed audio chunk (raw PCM, `application/octet-stream`) |
| `DELETE` | `/v1/audio/transcriptions/stream/:id` | Stop session, get final text |

Any macOS app or server that implements the streaming session API above can
serve as the backend. A typical setup is a local menu bar app running
Qwen3-ASR on Apple Silicon, exposing the API on `localhost:9748`. Launch
the ASR server and Oppi connects automatically.

## Configuration

Edit `~/.config/oppi/config.json`, then restart the server (`kill $(lsof -ti:7749)`).

### Required

| Field | Default | Description |
|-------|---------|-------------|
| `sttEndpoint` | `http://localhost:9748` | STT server URL (must implement the streaming session API above) |
| `sttModel` | `mlx-community/Qwen3-ASR-1.7B-bf16` | Model identifier sent to the STT backend |

### Optional

| Field | Default | Description |
|-------|---------|-------------|
| `sttLanguage` | *(none)* | Language hint (ISO-639-1). Omit for auto-detect. |
| `preserveAudio` | `true` | Save audio as FLAC on the server |
| `maxDurationSec` | `0` | Max session length in seconds (0 = unlimited) |

### LLM Correction

Post-transcription LLM pass that fixes ASR errors using domain context
(e.g. "queen three point five" → "Qwen3.5").

| Field | Default | Description |
|-------|---------|-------------|
| `llmCorrectionEnabled` | `false` | Enable LLM correction on finalize |
| `llmEndpoint` | `http://localhost:8400` | OpenAI-compatible `/v1/chat/completions` endpoint |
| `llmModel` | `Qwen3.5-122B-A10B-4bit` | Model for correction |

### Term Sheets

Automatically extracts domain-specific terms (proper nouns, project names,
technical vocabulary) from workspace context and injects them into the ASR
model's system prompt. Improves accuracy at zero latency cost.

| Field | Default | Description |
|-------|---------|-------------|
| `termSheetEnabled` | `true` | Auto-generate term sheet from workspace files |
| `termSheetManualTerms` | `[]` | Extra terms to always include |
| `termSheetExtraFiles` | `[]` | Additional files to scan for terms |
| `termSheetExtraDirs` | `[]` | Additional directories to scan |
| `termSheetLlmCurationEnabled` | `false` | Filter extracted terms through LLM to reduce noise |

### Example

```json
{
  "asr": {
    "sttEndpoint": "http://localhost:9748",
    "sttModel": "mlx-community/Qwen3-ASR-1.7B-bf16",
    "preserveAudio": true,
    "llmCorrectionEnabled": true,
    "termSheetEnabled": true
  }
}
```

## Dual-Model ASR

The recommended ASR backend supports a hybrid streaming/batch strategy
that balances latency and accuracy. This is configured on the ASR server
side and is transparent to Oppi — the server sees a single STT endpoint
regardless of which models the backend uses internally.

- **Streaming model** (e.g. Qwen3-ASR 0.6B-4bit) — produces low-latency
  partials as the user speaks. Optimized for speed over accuracy.
- **Batch model** (e.g. Qwen3-ASR 1.7B-bf16) — on pause, the backend
  re-transcribes the full utterance with the larger model and sends a
  corrected replacement. This fixes errors from the streaming pass.

The result: fast typewriter feedback while speaking, accurate final text
after each pause.

## Performance

Measured on M3 Ultra with MLX-audio Qwen3-ASR:

| Model | Chunk latency | Memory | Notes |
|-------|---------------|--------|-------|
| 0.6B-4bit | ~79ms | ~750MB | Recommended for streaming partials |
| 1.7B-bf16 | ~138ms | ~3.4GB | Recommended for batch retranscription |

Both achieve O(1) per-chunk via encoder window caching and decoder KV
cache reuse. Latency is constant regardless of recording length.

- **Real-time factor**: 0.04x (0.6B) / 0.07x (1.7B) — well ahead of real-time
- **Language support**: Bilingual EN/ZH with mid-sentence code-switching
