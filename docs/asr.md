# Dictation / ASR

Oppi supports two dictation paths:

1. **On-device dictation** (Apple speech recognizer)
2. **Server dictation** (Oppi server forwards audio to an STT backend)

Server dictation is optional. If no STT backend is configured, dictation remains on-device.

## Dictation engines (iOS)

In **Settings → Voice Input → Dictation Engine**:

- **Automatic** — use server dictation when available, otherwise on-device
- **On-device** — always use Apple dictation
- **Server** — always route through server dictation

## Server dictation architecture

```text
iPhone mic → WSS /stream → Oppi server → STT backend → transcript
```

Dictation shares the same `/stream` WebSocket used for session events.

### Message flow

1. iOS sends `dictation_start`
2. iOS streams PCM audio frames (16kHz, 16-bit mono) as binary WS messages
3. Server forwards audio to the STT backend in chunks
4. Server sends incremental `dictation_result` updates
5. iOS sends `dictation_stop`
6. Server sends `dictation_final` (and `audioId` when audio preservation is enabled)

## STT backend API contract

The STT backend must implement this session API:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/audio/transcriptions/stream` | Create streaming session |
| `POST` | `/v1/audio/transcriptions/stream/:id` | Send audio chunk (`application/octet-stream`) |
| `DELETE` | `/v1/audio/transcriptions/stream/:id` | End session and return final text |

Session creation body:

```json
{ "model": "<model-id>", "stream_config": { "system_prompt": "..." } }
```

`stream_config` is optional.

## Local and remote STT backends

`asr.sttEndpoint` can point to either:

- a **local** backend (`http://localhost:9748`), or
- a **remote** backend (`https://asr.example.com`)

### Remote ASR capability

Remote ASR is supported as long as the endpoint matches the API contract above.

Important details:

- Connectivity is from **server → STT backend**, not phone → STT backend.
- Prefer `https://` for non-local endpoints.
- Added network latency directly affects partial/final transcript latency.
- Oppi currently configures only endpoint/model/preserveAudio for ASR. If your remote STT requires custom auth headers, terminate auth at a reverse proxy in front of the STT service.

## Server config

Edit `~/.config/oppi/config.json`:

```json
{
  "asr": {
    "sttEndpoint": "http://localhost:9748",
    "sttModel": "mlx-community/Qwen3-ASR-1.7B-bf16",
    "preserveAudio": true
  }
}
```

Supported `asr` keys:

| Field | Type | Default | Description |
|---|---|---|---|
| `sttEndpoint` | string | `http://localhost:9748` | STT backend base URL |
| `sttModel` | string | `mlx-community/Qwen3-ASR-1.7B-bf16` | Model ID sent to backend |
| `preserveAudio` | boolean | `true` | Save finalized dictation audio as FLAC |

Restart the server after config changes.

## Storage

When `preserveAudio` is true, finalized recordings are written under:

- `<OPPI_DATA_DIR>/dictation/YYYY/MM/DD/*.flac`
- metadata JSON alongside each audio file

## Troubleshooting

- If server dictation is unavailable, switch iOS Dictation Engine to **On-device** to verify microphone and permissions.
- If using a remote endpoint, verify server host connectivity to the STT service and TLS certificate validity.
- Check server logs for `dictation_error` and STT HTTP status failures.