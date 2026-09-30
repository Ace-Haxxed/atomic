# Atomic

A native-feeling desktop AI app. Tauri 2, React 19, TypeScript, Tailwind v4.

Atomic is a local-first assistant with three modes — **Chat**, **Cowork** and
**Code** — over a single streaming agent runtime. It talks to
[OpenCode Zen](https://opencode.ai/docs/zen), keeps your data in SQLite on your
machine, and puts your API key in your OS keychain rather than in its own
database.

## Status

The first vertical slice is built and green: the host-agnostic core, the Tauri
shell, and a working streaming chat with tool approvals.

Not built yet: browser tools, notifications wiring, the release pipeline's first
run, and Cowork's unattended mode.

## Quick start

Requires Node 20.19+, pnpm 12, and a Rust toolchain with the
[Tauri Linux prerequisites](https://tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm dev          # Vite only, for UI work
pnpm tauri dev    # the real app
```

You need an [OpenCode Zen](https://opencode.ai/zen) API key. Onboarding will
ask for one on first launch; you can skip it and set the key later in Settings.

## Layout

```
packages/core     host-agnostic runtime: providers, agent, tools, storage, settings
packages/ui       design system: tokens, theme, primitives
apps/desktop      Tauri shell + React app
  src-tauri       native side: keyring, settings file, tray, dialogs, shortcuts
```

The core never imports `process`, `node:os`, or a SQLite driver. It declares
`Database`, `SecretStore` and `HostApi` as interfaces, and the Tauri side
implements them. That boundary is what keeps a future `atomic serve` a transport
change rather than a rewrite, and it is why the core has 139 tests that run
without a browser or an OS.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Vite dev server on :1420 |
| `pnpm tauri dev` | The full app with hot reload |
| `pnpm tauri build` | Native bundle for the current platform |
| `pnpm test` | Vitest across core and desktop |
| `pnpm typecheck` | Project-reference type check |
| `pnpm build` | Core, then the desktop frontend |
| `cd apps/desktop/src-tauri && cargo test` | Native unit tests |

## How it fits together

`LocalHost` (`packages/core/src/host/local.ts`) is the only implementation of
`HostApi`. The desktop composition root in
`apps/desktop/src/lib/bootstrap.ts` supplies the four things core cannot know:
the platform, the keychain, SQLite and the app directories. The React app talks
to that one object — there is no second path to the model, the database or the
keychain.

Runs stream over `api.streamEvents()`, an async iterable of flat,
JSON-serialisable events. The same union is what a socket client would receive,
so the transport is the only thing that would change.

## Permissions

Every mode starts at `ask`. The four levels, in order of increasing autonomy:

| Level | Behaviour |
| --- | --- |
| `ask` | Every call that changes something waits for approval |
| `auto-accept` | File edits go through; shell, network and MCP still ask |
| `plan` | Read-only. The agent investigates and stops with a plan |
| `bypass` | Nothing asks |

Two rules hold at every level, including bypass:

- an explicit deny always wins over an allow;
- `bypass` requires a one-time written acknowledgement, and while it is active the
  app shows a persistent banner.

`auto-accept` is deliberately narrow. Editing a file you already have open is
cheap to undo; running a command or reaching the network is not.

## Where data lives

| | |
| --- | --- |
| Linux | `~/.local/share/dev.atomic.app/` |
| macOS | `~/Library/Application Support/dev.atomic.app/` |
| Windows | `%APPDATA%\dev.atomic.app\` |

That directory holds `atomic.db` (SQLite), `attachments/` and `checkpoints/`.
Settings are a separate `settings.json` in the OS config dir, written atomically
so a crash cannot corrupt it.

The desktop app asks the OS for these paths and uses them verbatim. There is a
second, root-based resolver in `packages/core` for hosts that only know
`$XDG_DATA_HOME` or `%APPDATA%`; it appends the app directory itself, so passing
it an already-app-specific path would repeat the segment. `deriveAppDirs` throws
on that shape rather than letting it reach SQLite, which fails with
`SQLITE_CANTOPEN` (code 14) and no explanation.

## Schema changes

**Applied migrations are immutable. To change the schema, append a new migration
— never edit or renumber one that has shipped.**

`packages/core/src/storage/migrations.ts` records the id of every migration a
database has applied and skips those forever, so editing one does nothing at all
to an existing database. The code and the database then quietly disagree about
the schema, and the failure surfaces later as a missing column instead of as a
migration error. This happened: `messages.display` was added by editing the
shipped migration 4, and every database that had already run it failed to start
with `table messages has no column named display`.

`runMigrations` checksums each applied migration and refuses to start on a
mismatch, naming the migration, rather than guessing. A checksum test in
`packages/core/src/storage/migrations.test.ts` pins the SQL of every shipped
migration, so editing one fails the test suite. Add new columns through a
migration's `addColumns` list rather than a bare `ALTER TABLE`, because SQLite
has no `ADD COLUMN IF NOT EXISTS`.

Recovery steps, and the one case where editing history by hand is correct, are
in [docs/schema-migrations.md](docs/schema-migrations.md).

## Security notes

- **API keys** go to the OS keychain (Keychain, Credential Manager, Secret
  Service) and are never written to SQLite, never returned in a settings blob,
  and never quoted in an error message.
- **Model output is never parsed as HTML.** `apps/desktop/src/lib/markdown-parse.ts`
  turns text into a token tree; the view maps tokens to React elements. There is
  no `innerHTML` and no `dangerouslySetInnerHTML` in the app, so markup in a
  response is inert by construction rather than by sanitisation.
- **The environment is not dumped.** The native side returns an allowlist of
  provider-key variables. `HostServices.env` is indexed by a user-editable
  setting, so a full dump would have turned "read my model key" into
  "exfiltrate every secret in the process".
- **CSP** lives in `tauri.conf.json` as the single source of truth. Scripts,
  styles and frames are pinned to `'self'`; only the network namespace is open,
  because the model endpoint is configurable.
- **No telemetry.** There is no analytics endpoint and telemetry is off by
  default. The only outbound requests are the model calls you start.

## Releasing

`tauri.conf.json` ships a placeholder updater public key
(`REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY`). Replace it with the real minisign
public key from `tauri signer generate` **before** publishing a build, or
in-app updates will fail to verify. The GitHub Actions workflow
(`.github/workflows/release.yml`) builds a matrix of Linux, macOS and Windows
artifacts on a tag.

```bash
pnpm tauri signer generate -w ~/.tauri/atomic.key   # once
```

## Licence

MIT.
