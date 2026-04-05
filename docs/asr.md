# Server-Side ASR (Speech Recognition)

Oppi can use a local speech recognition model running on your Mac for voice
dictation. When configured, the iOS app streams audio to the Oppi server over
WebSocket, and the server transcribes it using an OpenAI-compatible STT endpoint.

## Requirements

- Any server running an OpenAI-compatible `/v1/audio/transcriptions` endpoint
  (e.g. [oMLX](https://github.com/jundot/omlx), vLLM, LocalAI, or a cloud
  provider like OpenAI, Groq, Deepgram)
- Optional: A local LLM for post-transcription correction via an
  OpenAI-compatible `/v1/chat/completions` endpoint

## Configuration

Add an `asr` block to your server config (`~/.config/oppi/config.json`):

```json
{
  "asr": {
    "sttEndpoint": "http://localhost:9847",
    "sttModel": "mlx-community/Qwen3-ASR-1.7B-bf16"
  }
}
```

If the `asr` block is absent or `sttEndpoint` is not set, server-side
dictation is disabled and the `/dictation` WebSocket endpoint returns 404.
The iOS app falls back to Apple's on-device dictation.

### All options

| Field | Default | Description |
|-------|---------|-------------|
| `sttEndpoint` | *(required)* | STT server URL (OpenAI-compatible) |
| `sttModel` | `mlx-community/Qwen3-ASR-1.7B-bf16` | Model to request from the STT backend |
| `llmEndpoint` | `http://localhost:8400` | LLM server for post-transcription correction |
| `llmModel` | `Qwen3.5-122B-A10B-4bit` | LLM model for correction |
| `llmCorrectionEnabled` | `true` | Run LLM correction on dictation stop |
| `preserveAudio` | `true` | Save dictation audio as FLAC on the server |
| `maxDurationSec` | `300` | Max dictation session length (0 = unlimited) |
| `retranscribeIntervalMs` | `2000` | Base interval for interim results |

### Minimal config (STT only, no LLM correction)

```json
{
  "asr": {
    "sttEndpoint": "http://localhost:9847",
    "llmCorrectionEnabled": false
  }
}
```

### Full config

```json
{
  "asr": {
    "sttEndpoint": "http://localhost:9847",
    "sttModel": "mlx-community/Qwen3-ASR-1.7B-bf16",
    "llmEndpoint": "http://localhost:8400",
    "llmModel": "Qwen3.5-122B-A10B-4bit",
    "llmCorrectionEnabled": true,
    "preserveAudio": true,
    "maxDurationSec": 300,
    "retranscribeIntervalMs": 2000
  }
}
```

## How it works

1. **iOS app** streams raw PCM audio (16kHz, 16-bit, mono) over a `/dictation`
   WebSocket to the Oppi server.

2. **Oppi server** accumulates audio and retranscribes the full buffer every
   2 seconds (adaptive — slows for longer sessions). Each retranscription sends
   the complete accumulated audio to the STT backend, avoiding the quality loss
   from independent chunk-by-chunk transcription.

3. **Interim results** are sent back to the phone as each retranscription
   completes. The transcript grows and refines in real time.

4. **On stop**, the server does a final transcription. If LLM correction is
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

## Audio storage

Preserved audio is stored at:

```
<dataDir>/dictation/YYYY/MM/DD/<audioId>.flac
<dataDir>/dictation/YYYY/MM/DD/<audioId>.json
```

The JSON metadata includes the transcript, duration, model used, and
timestamps. Storage cost is approximately 1 MB per minute of audio.
