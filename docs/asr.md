# Server-Side ASR (Speech Recognition)

Oppi can use a local speech recognition model running on your Mac for voice
dictation. When configured, the iOS app streams audio to the Oppi server over
WebSocket, and the server transcribes it using an OpenAI-compatible STT endpoint.

## Requirements

Either:
- **qwen_asr** (recommended): [antirez/qwen-asr](https://github.com/antirez/qwen-asr),
  a pure C Qwen3-ASR implementation. Streams tokens as they're decoded —
  O(n) instead of O(n²) retranscription.
- **HTTP STT server**: Any OpenAI-compatible `/v1/audio/transcriptions` endpoint
  (e.g. mlx_server, vLLM, LocalAI, or a cloud provider like OpenAI, Groq,
  Deepgram, ElevenLabs)

Optional: A local LLM for post-transcription correction via an
OpenAI-compatible `/v1/chat/completions` endpoint.

## Configuration

Add an `asr` block to your server config (`~/.config/oppi/config.json`).

### qwen_asr (streaming, recommended)

```json
{
  "asr": {
    "sttProvider": "qwen_asr",
    "sttBinary": "/path/to/qwen_asr",
    "sttModelDir": "/path/to/qwen3-asr-0.6b"
  }
}
```

The binary is spawned per dictation session. Raw PCM audio is piped to stdin
and decoded tokens arrive from stdout in real time. No retranscribe timer,
no HTTP overhead.

### HTTP provider

```json
{
  "asr": {
    "sttEndpoint": "http://localhost:9847",
    "sttModel": "mlx-community/Qwen3-ASR-1.7B-bf16"
  }
}
```

If the `asr` block is absent (or neither `sttBinary` nor `sttEndpoint` is set),
server-side dictation is disabled and the `/dictation` WebSocket endpoint
returns 404. The iOS app falls back to Apple's on-device dictation.

### All options

| Field | Default | Description |
|-------|---------|-------------|
| `sttProvider` | `mlx-server` | Provider type: `qwen_asr`, `mlx-server`, `openai`, `deepgram`, `elevenlabs` |
| `sttBinary` | *(none)* | Path to `qwen_asr` binary (required when `sttProvider` is `qwen_asr`) |
| `sttModelDir` | *(none)* | Path to model directory (required when `sttProvider` is `qwen_asr`) |
| `sttEndpoint` | *(none)* | STT server URL (required for HTTP providers) |
| `sttModel` | `mlx-community/Qwen3-ASR-1.7B-bf16` | Model to request from the HTTP STT backend |
| `sttApiKey` | *(none)* | API key for the STT backend (Bearer token) |
| `llmEndpoint` | `http://localhost:8400` | LLM server for post-transcription correction |
| `llmModel` | `Qwen3.5-122B-A10B-4bit` | LLM model for correction |
| `llmCorrectionEnabled` | `false` | Run LLM correction on dictation stop |
| `preserveAudio` | `true` | Save dictation audio as FLAC on the server |
| `maxDurationSec` | `0` | Max dictation session length in seconds (0 = unlimited) |
| `retranscribeIntervalMs` | `2000` | Base interval for interim results (HTTP providers only) |

### Authentication

For cloud STT providers that require an API key, set it via environment
variable (recommended) or in the config file:

```bash
# Environment variable (takes priority)
export OPPI_STT_API_KEY="gsk_..."
```

Or in `config.json`:

```json
{
  "asr": {
    "sttEndpoint": "https://api.groq.com/openai",
    "sttApiKey": "gsk_..."
  }
}
```

### Example: qwen_asr streaming (recommended)

```json
{
  "asr": {
    "sttProvider": "qwen_asr",
    "sttBinary": "~/workspace/qwen-asr/qwen_asr",
    "sttModelDir": "~/workspace/qwen-asr/qwen3-asr-0.6b"
  }
}
```

### Example: Local HTTP STT (no auth)

```json
{
  "asr": {
    "sttEndpoint": "http://localhost:9847",
    "llmCorrectionEnabled": false
  }
}
```

### Example: Groq (free, no credit card)

Sign up at [console.groq.com/keys](https://console.groq.com/keys) to get
a free API key. Free tier includes ~8 hours of transcription per day.

```json
{
  "asr": {
    "sttEndpoint": "https://api.groq.com/openai",
    "sttModel": "whisper-large-v3-turbo",
    "sttApiKey": "gsk_...",
    "llmCorrectionEnabled": false
  }
}
```

### Example: Full config (local STT + local LLM)

```json
{
  "asr": {
    "sttEndpoint": "http://localhost:9847",
    "sttModel": "mlx-community/Qwen3-ASR-1.7B-bf16",
    "llmEndpoint": "http://localhost:8400",
    "llmModel": "Qwen3.5-122B-A10B-4bit",
    "llmCorrectionEnabled": true,
    "preserveAudio": true,
    "maxDurationSec": 0,
    "retranscribeIntervalMs": 2000
  }
}
```

## How it works

1. **iOS app** streams raw PCM audio (16kHz, 16-bit, mono) over a `/dictation`
   WebSocket to the Oppi server.

2. **Oppi server** pipes audio to the STT backend:
   - **qwen_asr (streaming)**: audio is piped to the binary's stdin.
     Decoded tokens arrive on stdout as they're produced — O(n) total
     compute instead of O(n²) retranscription. No timer, no HTTP.
   - **HTTP providers**: accumulates audio and retranscribes the full
     buffer every 2 seconds (adaptive — slows for longer sessions).

3. **Interim results** are sent back to the phone as tokens arrive
   (streaming) or as each retranscription completes (HTTP).

4. **On stop**, the server gets the final text (streaming: close stdin
   and wait for exit; HTTP: one final transcription). If LLM correction is
   enabled, it sends the raw transcript through the LLM to fix speech-to-text
   errors (e.g. "queen three point five" → "Qwen3.5") and extract new terms
   for a self-improving domain dictionary.

5. **Audio preservation** saves the full dictation audio as a lossless FLAC
   file on the server for later playback or re-transcription.

## iOS settings

In the Oppi iOS app, go to **Settings → Voice Input → Dictation Engine**:

- **Automatic** — uses server dictation when connected, falls back to on-device
- **On-device** — Apple's built-in dictation only
- **Server** — always route through the Oppi server

## Domain dictionary

The server maintains a dictionary at `<dataDir>/dictation/dictionary.json`
that improves accuracy over time. When LLM correction is enabled, each
dictation session can add new corrections and domain terms.

The dictionary is passed as context to subsequent transcriptions, so
frequently-used terms (project names, code identifiers, technical jargon)
are recognized correctly after the first correction.

## Building qwen_asr

```bash
git clone https://github.com/antirez/qwen-asr
cd qwen-asr
make blas          # uses Accelerate.framework on macOS
./download_model.sh --model small   # downloads qwen3-asr-0.6b (~1.2 GB)
```

Verify it works:

```bash
# Should print nothing meaningful (silence → no speech tokens)
dd if=/dev/zero bs=32000 count=1 2>/dev/null | ./qwen_asr -d qwen3-asr-0.6b --stdin --stream
```

Then point your Oppi config at the binary and model directory.

## Audio storage

Preserved audio is stored at:

```
<dataDir>/dictation/YYYY/MM/DD/<audioId>.flac
<dataDir>/dictation/YYYY/MM/DD/<audioId>.json
```

The JSON metadata includes the transcript, duration, model used, and
timestamps. Storage cost is approximately 1 MB per minute of audio.
