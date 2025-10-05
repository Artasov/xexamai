Local Whisper HTTP API

This repo can use a local, OpenAI‑compatible Whisper server for audio transcription.

Endpoints implemented:

- `GET /` – health banner
- `GET /v1/models` – list supported models
- `POST /v1/audio/transcriptions` – transcribe audio, returns `{ text: "..." }` by default
- `POST /v1/audio/translations` – translate audio to English
- `GET /healthz` – simple health check

Response formats supported via `response_format` form field: `json` (default), `text`, `srt`, `vtt`, `verbose_json`.

Supported model IDs: `tiny`, `tiny.en`, `base`, `base.en`, `small`, `small.en`, `medium`, `medium.en`, `large`, `large-v1`, `large-v2`, `large-v3`.

Setup

1) Install Python 3.10+ and create a virtualenv (recommended).
2) Install requirements:

   pip install -r server/requirements.txt

3) Run the API (defaults to port 8000):

   uvicorn server.fast_fast_whisper.app:app --host 0.0.0.0 --port 8000

Optional environment variables:

- `WHISPER_DEVICE` – `auto` (default), `cpu`, `cuda`, etc.
- `WHISPER_COMPUTE_TYPE` – `auto` (default), e.g. `int8`, `float16`.
- `WHISPER_CPU_THREADS` – integer, number of CPU threads (default auto).

Electron app integration

- Set `LOCAL_WHISPER_API_BASE` (e.g., `http://localhost:8000`) in your environment when running the app.
- In Settings, choose Transcription Mode: Local, then pick a local Whisper model (e.g., `base`, `small`, `medium`, `large-v3`).

Models are downloaded on first use to the local `./models` directory.

