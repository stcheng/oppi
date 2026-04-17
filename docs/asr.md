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
6. Server sends `dictation_final`

## STT backend API contract

The STT backend must implement this session API:

| Method   | Path                                  | Purpose                                       |
| -------- | ------------------------------------- | --------------------------------------------- |
| `POST`   | `/v1/audio/transcriptions/stream`     | Create streaming session                      |
| `POST`   | `/v1/audio/transcriptions/stream/:id` | Send audio chunk (`application/octet-stream`) |
| `DELETE` | `/v1/audio/transcriptions/stream/:id` | End session and return final text             |

Session creation body:

```json
{ "model": "<model-id>", "stream_config": { "system_prompt": "..." } }
```

`stream_config` is optional.

## Local and remote STT backends

`asr.sttEndpoint` can point to either:

- a **local** backend (`http://localhost:7936`), or
- a **remote** backend (`https://asr.example.com`)

### Remote ASR capability

Remote ASR is supported as long as the endpoint matches the API contract above.

Important details:

- Connectivity is from **server → STT backend**, not phone → STT backend.
- Prefer `https://` for non-local endpoints.
- Added network latency directly affects partial/final transcript latency.
- Oppi currently configures only `asr.sttEndpoint` for ASR. If your remote STT requires custom auth headers, terminate auth at a reverse proxy in front of the STT service.

## Server config

Edit `~/.config/oppi/config.json`:

```json
{
  "asr": {
    "sttEndpoint": "http://localhost:7936"
  }
}
```

Supported `asr` keys:

| Field         | Type   | Default                 | Description          |
| ------------- | ------ | ----------------------- | -------------------- |
| `sttEndpoint` | string | `http://localhost:7936` | STT backend base URL |

Restart the server after config changes.

## Audio retention

Oppi server does not persist dictation audio locally.

If you need archival, configure it in your STT backend (for example YUWP).

## Troubleshooting

- If server dictation is unavailable, switch iOS Dictation Engine to **On-device** to verify microphone and permissions.
- If using a remote endpoint, verify server host connectivity to the STT service and TLS certificate validity.
- Check server logs for `dictation_error` and STT HTTP status failures.
