<div align="center">
  <img src="brand/logo_white.png" alt="XEXAMAI logo" width="248" height="248">
  <h1>XEXAMAI</h1>
  <p><strong>A desktop AI assistant for interviews, study sessions, and spoken questions.</strong></p>
</div>

<div align="center">
  <a href="https://github.com/Artasov/xexamai/releases/latest">
    <img src="https://img.shields.io/badge/Download-Latest%20Release-blue?style=for-the-badge" alt="Download the latest release">
  </a>
</div>

<div align="center">
  <a href="https://github.com/Artasov/xexamai/blob/main/README.md">English</a>
  ·
  <a href="https://github.com/Artasov/xexamai/blob/main/README_RU.md">Русский</a>
</div>

XEXAMAI is a Tauri 2 desktop application. It can keep a rolling in-memory audio buffer, transcribe a selected part of that buffer, and send the recognized question to a selected AI model. Microphone, system-audio, and mixed capture modes are available, with the strongest system-audio support on Windows.

Use the application only where AI assistance and recording are permitted. You are responsible for consent, confidentiality, and the rules of the interview, exam, meeting, or service you use.

## Features

- Native Rust audio capture with microphone, system-audio, and mixed modes.
- Live input switching while recording, plus configurable buffer durations and global hotkeys.
- OpenAI, OpenAI Realtime (`gpt-live-transcribe`), Google Gemini, Google Live, Winky, Ollama, and local `fast-fast-whisper` modes.
- Streaming answers and realtime OpenAI or Google transcription into the question field. OpenAI Realtime does not force a language, allowing the service to handle multilingual speech and code-switching automatically.
- Local conversation history with search, filters, pinning, rename, retry, export, deletion, and configurable retention.
- User-initiated screenshot analysis through OpenAI or Google.
- OAuth or email/password sign-in for the XEXAMAI backend and Winky features.
- Signed in-app update downloads with an explicit install step.
- Always-on-top, opacity, scaling, and a best-effort Windows capture-exclusion option.

Local modes do not incur OpenAI or Google API usage, but they require local software and hardware resources. Cloud-provider usage is subject to that provider's account, quota, billing, and data-handling terms. Winky can require an XEXAMAI account and credits; screenshot processing currently also requires a server-verified feature entitlement even when the selected model uses the user's provider key.

## Quick start

1. Install a build from [GitHub Releases](https://github.com/Artasov/xexamai/releases/latest) and open XEXAMAI.
2. Sign in, then choose an AI and transcription mode in **Settings**.
3. For OpenAI or Google BYOK modes, add the corresponding API key. For local modes, start Ollama and/or the local speech service.
4. Select **Microphone**, **System audio**, or **Mic + System**, and choose the microphone device when applicable.
5. Start recording. XEXAMAI keeps only the configured recent portion in its rolling memory buffer. If OpenAI Realtime or Google Live transcription is selected, recording also starts continuous audio streaming to that provider until recording or that mode stops.
6. Send the desired duration, type a question, start a stream, or explicitly capture a screenshot.

Test audio and provider access before an important session. The first local request may be slower while models are downloaded or loaded into RAM/VRAM.

## Data flow at a glance

"Local" describes where inference happens; it does not mean that the whole application is offline. The app automatically restores an existing account session and profile at launch, refreshes profile/entitlements when the window regains focus or visibility and about every five minutes while active, and checks the signed update channel at startup and periodically. Login, feedback, and enabled provider actions make their documented requests as well.

| Mode or action | Data sent | Destination |
| --- | --- | --- |
| Local speech (`fast-fast-whisper`) | The selected audio fragment | The local service at `127.0.0.1:8868` |
| Local LLM (Ollama) | Prompt and selected conversation context | The local service at `127.0.0.1:11434` |
| OpenAI buffered transcription/LLM | Selected audio, prompts/context, or a screenshot, depending on the action | `api.openai.com` |
| OpenAI Realtime (`gpt-live-transcribe`) | Starting recording with this model selected continuously streams the selected audio over a direct WebSocket. The long-lived key stays in Rust; the renderer receives only a short-lived client secret. Recognized text is written into the question field. | `wss://api.openai.com` |
| Google standard | Selected audio, prompts/context, or a screenshot, depending on the action | `generativelanguage.googleapis.com` |
| Google Live | Starting recording with a Live transcription model selected continuously sends the selected audio over a direct WebSocket; a one-use temporary token is used by the renderer | Google Live API |
| Winky | Account/profile requests, prompts/context, or an uploaded audio fragment | The selected `xlartas.com` or `xlartas.ru` backend |
| Feedback | Subject, message, contact, selected images, and optional diagnostics | The selected XEXAMAI backend |

For accounts with the `history` entitlement, conversation history is stored locally in the webview profile and scoped by backend and account. Without it, the current conversation remains memory-only and existing stored data is preserved but not loaded. Signing out isolates the previous account's history but does not delete it. The default retention is 90 days; pinned chats are retained until unpinned or deleted. Screenshots themselves are not written to chat history, but the screenshot marker, prompt, and answer are.

XEXAMAI writes local diagnostic logs. Those logs can include short previews of prompts, transcripts, and responses. Credential-shaped fields are redacted on a best-effort basis, but logs should still be treated as potentially sensitive. They are not uploaded automatically; a cleaned recent excerpt is attached to feedback only when the checkbox for that report is enabled.

The manual `save_recorder_files` setting is off by default. If enabled, submitted audio fragments are also kept as raw debug files under app local data in `transcription_debug`, without automatic retention. Delete them manually when they are no longer needed.

See [Security and privacy](SECURITY.md) for the full per-mode matrix, credential storage, deletion caveats, and platform limitations.

## Local AI

### Ollama

1. Install [Ollama](https://ollama.com/).
2. Download a model, for example:

   ```shell
   ollama pull qwen3:4b
   ```

3. Start Ollama if it is not already running:

   ```shell
   ollama serve
   ```

4. In XEXAMAI, set the LLM host to **Local**, select an installed model, and use the built-in availability test.

XEXAMAI only accepts the loopback Ollama endpoint. Ollama owns its model cache and any logs it creates.

### fast-fast-whisper

In local transcription mode, the Settings screen can install, start, stop, restart, and check the bundled integration with [fast-fast-whisper](https://github.com/Artasov/fast-fast-whisper). You can also run that repository manually on port `8868`.

The helper has its own Python environment, downloaded models, cache, and log files. Its supplied start scripts may listen on all network interfaces; use host firewall rules or change the helper binding if the machine is on an untrusted network. XEXAMAI itself connects to it through `127.0.0.1` and verifies the service identity before treating the endpoint as ready.

GPU acceleration depends on the local helper, model, drivers, CUDA/cuDNN compatibility, and available VRAM. Follow the helper repository's current setup instructions rather than relying on a fixed CUDA version in this README.

## Platform notes

- **Windows:** native WASAPI loopback is used for system audio and mixed capture. This is the primary tested path.
- **macOS:** microphone capture uses the system audio API. System/mixed capture requires a virtual input such as BlackHole, Loopback, or Soundflower and the required OS permissions.
- **Linux:** system/mixed capture requires a usable PulseAudio or PipeWire monitor source. Desktop portal, compositor, tray, and shortcut behavior can vary.
- **Screen capture:** the OS/webview display picker is shown for each capture. The selected frame is resized before processing.
- **Hide from capture:** Windows uses `SetWindowDisplayAffinity` as a best-effort measure. It is not a promise of invisibility and can vary by Windows version, capture software, remote desktop, or capture method. Equivalent exclusion is not implemented for macOS or Linux.

## Development

### Requirements

- Node.js 24 and npm
- Rust 1.97 with Cargo
- The [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for the host platform

### Setup

```shell
git clone https://github.com/Artasov/xexamai.git
cd xexamai
npm ci
npm run dev
```

### Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the Tauri desktop app in development mode |
| `npm run dev:renderer` | Run only the Vite renderer |
| `npm run typecheck` | Type-check TypeScript |
| `npm test` | Run renderer tests |
| `npm run build:renderer` | Build only the renderer bundle |
| `npm run build` | Build and package the Tauri app for the current host platform |
| `npm run bindings:generate` | Regenerate Rust-to-TypeScript IPC bindings |
| `npm run bindings:check` | Check the generated IPC command map |

Packaged output is written under `src-tauri/target/release/bundle/`. Native Windows, macOS, and Linux release artifacts are built on their respective runners; local `npm run build` packages only for the current host and toolchain.

### Project structure

```text
src/
├── renderer/       # React renderer and application UI
└── shared/         # Shared and generated TypeScript contracts
src-tauri/
├── src/            # Rust desktop host, audio, auth, updater, and provider proxies
├── capabilities/   # Tauri command permissions
└── tauri.conf.json # Desktop and bundle configuration
scripts/            # Release, version, and update-manifest tooling
```

Contributions are welcome through pull requests. For a vulnerability, use the private reporting route described in [SECURITY.md](SECURITY.md), not a public issue.

## License

XEXAMAI is licensed under the [Mozilla Public License 2.0](LICENSE). Commercial use is
permitted, but modifications to MPL-covered files remain subject to the MPL. Copyright and
attribution notices must be preserved as described in [NOTICE](NOTICE).

The XEXAMAI name, logos, visual identity, and other brand assets are not licensed under the
MPL 2.0. See [TRADEMARKS.md](TRADEMARKS.md) and [brand/README.md](brand/README.md) for the
brand-use rules. Third-party components and marks remain subject to their own licenses and owners.
