# Repository Guidelines

## Project Structure & Module Organization

- Source: src/main/ (Electron main, IPC, services), src/renderer/ (UI: ui/, audio/, state/), src/preload/ (exposes a
  typed bridge).
- Config: configs/ (Tailwind, PostCSS), scripts/ (build helpers), brand/ (icons).
- Build outputs: build/ (compiled TS for main/renderer), dist/ (CSS, packaged artifacts).

## Build, Run, and Package

- npm run dev — compile and launch Electron in development.
- npm run build — clean, compile TypeScript, process CSS, copy HTML.
- npm run build:win|mac|linux|all — create platform packages.
- npm run clean — remove build outputs.

## Coding Style & Naming Conventions

- TypeScript with strict: true; prefer 4‑space indent in TS, 2 in JSON.
- camelCase for variables/functions; PascalCase for types/enums.
- Files: kebab‑case with role suffix, e.g. assistant.service.ts, whisper.client.ts, settings.ipc.ts, MainWindow.ts for
  windows.
- Prefer named exports; keep modules focused and side‑effect free where possible.

## Testing Guidelines

- No automated tests yet; validate via
  npm run dev and manual flows (recording, transcript, AI reply, opacity, device selection).
- When adding logic, extract pure helpers (e.g., under src/main/services or src/renderer/*) to ease future unit tests.
- Include a manual test plan in PRs (OS, steps, expected/actual).

## Commit & Pull Request Guidelines

- Commits are short and imperative (current history: "init", "process", "reformatting"); no strict convention enforced.
  Optionally use scope: summary.
- PRs should include: clear description, before/after screenshots or GIFs for UI, validation steps, related issues, and
  platform notes. Update README if behavior changes.

## Security & Configuration Tips

- Never commit secrets. Provide OPENAI_API_KEY via app Settings or .env in development; first run seeds config from env.
- App settings persist under Electron userData → xexamai/config.json (use "Open Config Folder" in Settings to inspect
  when debugging).