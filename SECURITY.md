# Security and Privacy

This document describes the current desktop implementation, not an absolute guarantee. Provider behavior and operating-system behavior are outside XEXAMAI's control and can change independently.

## Supported versions

| Version | Security support |
| --- | --- |
| Latest stable release | Supported |
| Current prerelease/beta | Best effort |
| Older releases | Upgrade required before reporting a fixed issue as unresolved |

Use the in-app update check or check [GitHub Releases](https://github.com/Artasov/xexamai/releases/latest). The in-app updater verifies Tauri update signatures before installation and asks before downloading/installing an available update.

## Reporting a vulnerability

Use a [private GitHub security advisory](https://github.com/Artasov/xexamai/security/advisories/new) when possible. Do not put API keys, tokens, private audio, screenshots, personal data, or exploit details in a public issue.

Include the affected version and OS, impact, reproducible steps, and the smallest safe proof of concept. Reports are reviewed on a best-effort basis; no fixed response or resolution SLA is promised.

## Trust boundaries

- The UI runs in a Tauri webview. Privileged operations are exposed through an allowlisted Tauri capability and typed Rust commands.
- OpenAI and standard Google requests are sent by the Rust host so long-lived provider API keys do not need to enter renderer state. Google Live is the deliberate exception: Rust exchanges the stored Google key for a one-use, model-constrained temporary token, and only that temporary token is returned to the renderer for the direct Live WebSocket.
- OAuth uses the system browser, PKCE, a one-time backend code, and the `xexamai://` deep link. The long-lived backend refresh token is kept in the OS credential store; the access token is kept in process memory.
- Remote traffic uses HTTPS/WSS. Local inference uses loopback HTTP. Redirects and remote provider/backend hosts are restricted by the native implementation and CSP.
- Release builds intentionally retain DevTools during the beta period. A person or process that can control the user's desktop session can inspect renderer state and interfere with the app; DevTools are not a security boundary.
- CSP, input limits, credential redaction, and OS credential storage are defense-in-depth. They do not protect against a compromised OS account, malware, an injected provider response exploiting an unknown webview bug, or a provider/backend compromise.

## Data-flow and privacy matrix

In buffered/local transcription modes, capture by itself does not send audio remotely. The explicit exception is Google Live: when a Google Live transcription model is selected, starting recording also starts continuous audio transfer to Google until recording stops or the transcription mode/model changes. Other remote transfers start when the user sends a buffered fragment, asks a remote model, captures a screenshot for analysis, signs in, checks account features, sends feedback, or downloads an update.

| Mode or action | Leaves the device? | Data and destination | Local/server persistence |
| --- | --- | --- | --- |
| Audio capture and rolling buffer | No in buffered/local modes; yes when Google Live is selected | Microphone, system audio, or their mix stays in application memory until another action consumes it. In Google Live mode, starting capture immediately begins the continuous transfer described below. | XEXAMAI does not intentionally write the raw rolling buffer to disk. It is limited to the actual configured duration and is cleared when the recording session is torn down. This is not a forensic guarantee against OS paging or crash capture. |
| Local transcription (`fast-fast-whisper`) | Not through XEXAMAI's remote services | The selected audio fragment is posted to `http://127.0.0.1:8868` | The helper is a separate process with its own environment, models, cache, and log. Its supplied start scripts can bind to `0.0.0.0`; firewall it or change its bind address on untrusted networks. |
| Local LLM (Ollama) | Not through XEXAMAI's remote services | Prompt, system instruction, and selected recent conversation context go to `http://127.0.0.1:11434` | Ollama controls its model cache, memory, and logs. XEXAMAI only allows the loopback endpoint. |
| OpenAI transcription/LLM | Yes | The chosen audio fragment for transcription and/or prompts, system instruction, recent context, and model parameters for generation go to `https://api.openai.com`. A screenshot is included only for an explicit screenshot-analysis action. | Provider-side processing, retention, abuse monitoring, and account billing follow the user's OpenAI account and OpenAI terms. |
| Google standard transcription/LLM | Yes | The chosen audio fragment and/or prompts, system instruction, recent context, and model parameters go to `https://generativelanguage.googleapis.com`. A screenshot is included only for an explicit screenshot-analysis action. | Provider-side processing and retention follow the user's Google project/account and Google terms. |
| Google Live | Yes, continuously while the Live session is active | Rust sends the long-lived Google key only to Google's auth-token endpoint. The renderer receives a one-use temporary token and streams selected audio directly to Google's Live WebSocket; Google returns realtime transcription/results. | XEXAMAI writes recognized text into the question field and can later store it in local history when sent. Google controls Live service retention and processing. |
| XEXAMAI authentication/profile/entitlements | Yes | Login or OAuth data, token refresh/logout, profile, tiers, and feature-entitlement requests go only to the selected `https://xlartas.com` or `https://xlartas.ru` backend | An existing secure session/profile is restored automatically at launch. Profile and entitlements refresh when the window regains focus/visibility and about every five minutes while authenticated. The backend stores account/profile and service records; local sign-out does not delete the backend account. |
| Winky LLM | Yes | Prompt plus selected recent conversation context is sent over `wss://xlartas.com` or `wss://xlartas.ru` using a short-lived WebSocket ticket | Generation, credits, and server records are controlled by the selected XEXAMAI backend and its server-side AI processing. |
| Winky transcription | Yes | The selected audio fragment is uploaded as private media to the selected XEXAMAI backend, then referenced by the transcription request | A completed upload is server-side data and can remain even if the following transcription request fails. Upload failures before completion are cleaned up on a best-effort basis; uninstalling or clearing local data does not delete successful server uploads. |
| Screenshot analysis | Yes | The OS/webview picker asks the user to choose a display/window; one JPEG frame is resized to at most 1920 pixels on its longest edge and sent to the selected OpenAI or Google screen operation | Screenshot pixels are held in memory and are not stored in local chat history. The history keeps a marker, any typed prompt, and the answer. The selected provider receives the pixels and applies its own policies. |
| Local conversation history | No automatic server sync | For accounts with the `history` entitlement, user/assistant/error text, timestamps, source/provider metadata, title, and pinned state are stored in webview local storage scoped by backend and account. Without that entitlement, the current conversation is memory-only and stored history is left untouched. | Default retention is 90 days; options are 30 days, 90 days, one year, or forever. Pinned and current chats are exempt from age pruning. At most 100 chats and 300 messages per chat are retained. This storage is not separately encrypted by XEXAMAI. |
| Feedback and media attachments | Yes, only on submit | Subject, message, supplied contact, and up to five selected image attachments go to the selected XEXAMAI backend as private issue media | Successful reports and attachments are server-side records. Closing/cancelling aborts active work, and failed partial uploads are deleted on a best-effort basis. |
| Optional feedback diagnostics | Yes, only when the per-report checkbox is selected | App version, OS/architecture, selected backend, model/provider, transcription/audio mode, a random trace ID, and up to 16 KiB of a recently redacted log preview are appended to the report | Credential-shaped values are redacted again before submission, but redaction is heuristic. Review the report and do not opt in when its content is too sensitive. |
| Application logs | No automatic upload | Local lifecycle, device, network status, errors, and short content previews used for debugging | The active log and one rotated log are kept in the app data directory, each limited to about 5 MiB. Prompt, transcript, or response previews can be up to 400 characters. Credential redaction is best effort, not a promise that all sensitive content is absent. |
| Optional raw transcription debug audio | No automatic upload beyond the transcription request itself | When the manual config flag `save_recorder_files` is `true` (default is `false`), each submitted audio fragment is also written under app local data in `transcription_debug` | These raw audio files have no automatic retention limit. They remain until explicitly deleted; sign-out and uninstall are not guaranteed to remove them. |
| Updates | Yes | The app automatically fetches the stable/beta signed update manifest at startup and periodically; artifacts download only after the user chooses Download | The release host necessarily sees ordinary request metadata such as IP address. Downloaded update artifacts can remain until installed or discarded. Installation is always an explicit action. |

XEXAMAI does not currently include a general-purpose analytics SDK. This does not make the app network-free: the rows above describe the functional network requests, and remote services may keep their own access/security logs.

## Credentials and local files

- OpenAI and Google API keys are stored through the OS credential store (Windows Credential Manager, macOS Keychain, or the available Linux Secret Service implementation). XEXAMAI does not claim stronger protection than the active OS account and credential-store backend provide.
- Email/password sign-in sends the submitted credentials to the selected XEXAMAI backend through the Rust host. The password is not intentionally persisted by the desktop app. OAuth additionally involves the selected identity provider in the system browser.
- Backend refresh tokens are scoped to `xlartas.com` or `xlartas.ru` and stored in that credential store. Backend access tokens are held in memory and refreshed as needed. Sign-out clears local session state first and attempts server-side revocation.
- Non-secret settings are stored in the Tauri application configuration directory. Provider keys are removed from the JSON configuration during migration, and sanitized backups do not contain those key fields. The settings file itself is not described as encrypted.
- The webview profile holds account-scoped chat history and a small amount of UI state, including the selected backend domain. History is not synchronized by XEXAMAI.
- Logs live in the application data directory. The Settings screen can open the configuration and log folders so the user can inspect them. If manually enabled, raw transcription debug audio is stored separately under local app data in `transcription_debug` and is not automatically pruned.
- Local AI helpers keep additional data outside the main configuration: Python environments, model weights, helper logs, Ollama models, and caches can be large and survive an app uninstall.

Never paste a provider key, password, access/refresh token, private transcript, or confidential screenshot into a bug report. Redaction is a safety net, not a substitute for review.

## Deletion, sign-out, and uninstall

- Deleting a chat removes that local chat from the current account/backend scope. Retention pruning is local and does not delete copies already sent to an AI provider or backend.
- Signing out clears the in-memory access token, removes the local refresh token, and attempts to revoke the backend session. It isolates but does not delete that account's local history. It also does not delete the account, feedback, successful Winky media, or provider-side requests.
- Removing a provider key in Settings removes the app's credential-store entry. It does not revoke the key at OpenAI or Google; revoke it in the provider console if exposure is suspected.
- Resetting settings is not equivalent to erasing every local artifact.
- OS uninstallers do not consistently remove application data, webview storage, credential-store entries, downloaded updates, `fast-fast-whisper`, Ollama models, or helper logs. Before uninstalling, sign out, remove provider keys, delete sensitive chats, stop local helpers, and use the Settings links to inspect the config/log directories. Remove remaining data and helper installations separately if required.
- Local deletion and uninstall cannot erase remote provider/backend records. Use the relevant provider/account deletion process or contact that service for remote-data requests.

## Platform and capture limitations

### Windows

- System and mixed audio use native WASAPI loopback; microphone capture uses the selected native input.
- The hide-from-capture setting uses `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`. It is best effort and is not a guarantee of invisibility. Older Windows versions, remote desktop, camera capture, privileged software, alternative capture APIs, or capture-tool behavior can still expose the window or a placeholder.
- Desktop notifications, global shortcuts, selected device identity, and audio permissions can change after OS/device updates. Test the exact setup before use.

### macOS

- Microphone permission is requested through macOS. System/mixed capture requires a virtual input/aggregate setup such as BlackHole, Loopback, or Soundflower.
- XEXAMAI does not implement the Windows capture-exclusion mechanism on macOS. Screen-capture permissions and the chosen capture source remain under macOS and the recording application.

### Linux

- System/mixed capture depends on a PulseAudio/PipeWire monitor or virtual sink being available.
- XEXAMAI does not implement the Windows capture-exclusion mechanism on Linux. Wayland/X11, portals, compositor, tray, focus, and global-shortcut behavior vary by distribution and desktop environment.

On every platform, screenshot analysis uses the webview/OS display picker. Read the selected target before approving it; XEXAMAI cannot determine whether confidential information is visible inside that target.

## User security checklist

- Install updates from the in-app updater or the official GitHub Releases page.
- Use separate, least-privilege provider keys with spending/quota limits where the provider supports them.
- Protect the OS account and credential store, and do not use sensitive sessions from a shared unlocked profile.
- Review the selected audio source, screenshot target, model/provider, conversation context, and diagnostic checkbox before sending.
- Treat local history and logs as sensitive files. Review them before sharing and delete them when no longer needed.
- Restrict local helper ports with the host firewall, especially because the supplied `fast-fast-whisper` launcher can listen beyond loopback.
- Revoke provider keys and backend sessions immediately if compromise is suspected.

## Developer security checklist

- Never commit signing keys, API keys, backend credentials, tokens, private transcripts, or captured media.
- Keep renderer capabilities and CSP destinations minimal; add a command or network origin only with a documented data flow.
- Keep long-lived credentials in Rust/OS credential storage. Do not return them to the renderer or put them in URLs/logs.
- Preserve request size limits, timeouts, cancellation, redirect blocking, server-side entitlement checks, and account/backend history scoping.
- Use the generated IPC bindings and validate all inputs again at the native/backend boundary.
- Review dependency and release changes separately for npm, Cargo, GitHub Actions, updater manifests, and backend APIs.
- Do not describe capture exclusion, local inference, credential redaction, or uninstall cleanup in absolute terms.
