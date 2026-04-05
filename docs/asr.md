# Dictation / ASR

Oppi's dictation pipeline lets you speak into the iOS app and have your
speech transcribed on your own hardware — fully private, no cloud APIs.

## Architecture

```
iPhone (mic) → WebSocket → Oppi Server → MLX Streaming Session → text
                                       ↓
                                   FLAC archive
```

The iOS app streams raw PCM audio (16kHz, 16-bit, mono) over a `/dictation`
WebSocket. The Oppi server manages a stateful streaming ASR session on the
MLX server, feeding 2-second audio chunks and receiving incremental
transcription updates. Each chunk takes ~138ms constant regardless of
session length (O(1) per chunk via encoder cache + KV reuse).

## Providers

| Provider | Type | Description |
|----------|------|-------------|
| `mlx-streaming` | **Default** | Stateful session via MLX server. O(1) per chunk, GPU-accelerated. |
| `qwen_asr` | Native binary | antirez/qwen-asr (pure C, CPU NEON). Spawns per session. |

## Configuration

Edit `~/.config/oppi/config.json`, then restart the server (`kill $(lsof -ti:7749)`).

### All options

| Field | Default | Description |
|-------|---------|-------------|
| `sttProvider` | `mlx-streaming` | Provider type: `mlx-streaming` or `qwen_asr` |
| `sttEndpoint` | `http://localhost:9847` | MLX server URL (for `mlx-streaming`) |
| `sttModel` | `mlx-community/Qwen3-ASR-1.7B-bf16` | Model to load |
| `sttBinary` | *(none)* | Path to `qwen_asr` binary (required for `qwen_asr` provider) |
| `sttModelDir` | *(none)* | Path to model directory (required for `qwen_asr` provider) |
| `sttLanguage` | *(none)* | Language hint (ISO-639-1). Omit for auto-detect (recommended). |
| `llmEndpoint` | `http://localhost:8400` | LLM server for post-transcription correction |
| `llmModel` | `Qwen3.5-122B-A10B-4bit` | LLM model for correction |
| `llmCorrectionEnabled` | `false` | Run LLM correction on dictation stop |
| `preserveAudio` | `true` | Save dictation audio as FLAC on the server |
| `maxDurationSec` | `0` | Max session length in seconds (0 = unlimited) |

### Example: MLX streaming (recommended)

```json
{
  "asr": {
    "sttProvider": "mlx-streaming",
    "sttEndpoint": "http://localhost:9847",
    "sttModel": "mlx-community/Qwen3-ASR-1.7B-bf16"
  }
}
```

### Example: qwen_asr (CPU-only fallback)

```json
{
  "asr": {
    "sttProvider": "qwen_asr",
    "sttBinary": "~/workspace/qwen-asr/qwen_asr",
    "sttModelDir": "~/workspace/qwen-asr/qwen3-asr-0.6b"
  }
}
```

## How it works

1. **iOS app** streams raw PCM audio over a `/dictation` WebSocket.

2. **Oppi server** manages a streaming ASR session:
   - Creates a session on the MLX server at dictation start
   - Feeds 2-second PCM chunks every 2 seconds
   - Receives incremental transcription text after each chunk
   - Pre-warms the next session after each stop for instant restart

3. **Interim results** are sent back to the phone as each chunk completes.
   The iOS client animates text appearing character-by-character (typewriter effect).

4. **On stop**, the server gets the final text. If LLM correction is
   enabled, it fixes ASR errors (e.g. "queen three point five" → "Qwen3.5").

5. **Audio preservation** saves the full session as lossless FLAC
   for later playback or re-transcription benchmarking.

## Performance

- **Per-chunk latency**: ~138ms constant (M3 Ultra, Qwen3-ASR-1.7B-bf16)
- **Real-time factor**: 0.07x (14x faster than real-time)
- **Language support**: Bilingual EN/ZH with mid-sentence code-switching
- **Total compute for 91s audio**: 6.3s (vs 97.9s with O(n²) retranscription)

## iOS settings

In the Oppi iOS app, go to **Settings → Voice Input → Dictation Engine**:

- **Automatic** — uses server dictation when connected, falls back to on-device
- **On-device** — Apple's built-in dictation only
- **Server** — always route through the Oppi server

When using server dictation, the mic button shows a cloud icon instead of
the keyboard language label (EN/中), since the model detects language automatically.
