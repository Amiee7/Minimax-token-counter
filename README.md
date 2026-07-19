# MiniMax Token Counter

A local desktop dashboard for MiniMax token usage and cost estimates.

The application contains no Codex integration and never exposes non-MiniMax
OpenCode models. Its compact source selector separates only these MiniMax data
boundaries:

- **MiniMax App** reads `~/.minimax/sqlite.db`.
- **OpenCode Zen** reads MiniMax events from providers `opencode` and
  `opencode-zen`.
- **OpenCode Go** reads MiniMax events from provider `opencode-go`.

## Features

- Local calendar-day token history
- Input, cache read, cache write, output, and reasoning breakdowns
- Per-model and per-session views
- Live snapshots without uploading local usage data
- Editable price presets and comparison estimates
- Strict MiniMax-only filtering for Zen and Go, including M3, M2.7, and M2.5
- Historical MiniMax M3 3x GO promotion detection from local cost signatures
- Cached startup with background refresh

## Privacy

All usage data stays on the local computer. The dashboard reads the configured
SQLite databases through a local server bound to `127.0.0.1`. Database files,
API keys, session contents, and user-specific paths are not part of this
repository or its release archives.

## Requirements

- Windows 10 or Windows 11 for the packaged desktop application
- Node.js 22.5 or newer for development

## Development

```powershell
npm install
npm run check
npm test
npm run desktop
```

The plain local server can be started with `npm start` and listens on
`http://127.0.0.1:4967`, falling back to the next free local port.

## Build

```powershell
npm install
npm run package:local
```

Build output:

```text
dist/
  MiniMaxTokenCounter.exe
  MiniMaxTokenCounter/
```

The launcher and the `MiniMaxTokenCounter` folder must remain next to each
other. The packaged server uses Electron's embedded Node runtime, so users do
not need a separate Node.js installation.

## GitHub releases

The included workflow runs syntax checks and tests on every push and pull
request. Tags matching `v*` additionally create a GitHub release containing a
Windows ZIP. The generated runtime and executables remain excluded from Git.

## Data rules

- Token totals come only from the selected source.
- Days begin at local midnight.
- OpenCode sessions are rebuilt from already filtered MiniMax events.
- Recorded tokens are never multiplied to simulate plans or promotions.
- The historical 3x GO marker requires a local `opencode-go/minimax-m3` cost
  signature close to one third of the calculated normal GO price.
- The marker is local evidence, not confirmation of a server-side quota debit.
- Price estimates never replace or alter recorded usage.

## License

MIT. See [LICENSE](LICENSE).
