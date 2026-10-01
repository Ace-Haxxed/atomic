# Cowork capabilities: extensions, connections, skills

## What already exists

Mapped before writing any code. The brief asked for a desktop agent workspace
with a multi-step agent, local file access, tool visibility, cancellation and a
provider layer. All of it is here already:

| Requirement | Where it lives |
| --- | --- |
| Desktop workspace | Tauri 2 + React 19, `apps/desktop` |
| Local files and folders | `tools/read.ts`, `tools/write.ts`, `FolderAccessPort`, sandbox in `src-tauri/src/workspace.rs` |
| Conversation + composer | `components/composer.tsx`, `components/message-list.tsx` |
| Tool calls, progress, results | `AgentEvent` stream, `components/tool-card.tsx` |
| Multi-step agent | `agent/loop.ts`, up to 200 steps per run |
| Session history | `storage/repositories.ts`, branching, export |
| Cancel / stop | `AbortController` per run, `cancelRun`, `cancelAll` |
| Provider abstraction | `models/provider.ts` + 8 providers incl. Ollama |
| Local-first | SQLite on disk, secrets in the OS keychain, no account |
| `cowork` mode | `MODES` in `settings/schema.ts` — **present but hidden** |

So this is not a build-from-scratch. It is three missing subsystems, plus a set
of places where the app currently tells the user or the model something untrue.

## What is missing

1. **No extension system.** Nothing declares resources or contributions; tools
   are a hardcoded array in `tools/index.ts`.
2. **No skills.** Nothing loads a named, configured, toggleable unit of
   instruction for the agent.
3. **MCP is schema-only.** `McpServerSchema` and `settings.mcpServers` parse and
   persist, and nothing reads them. There is no client, no discovery, no tools.
4. **No browser/computer-use.** `browser` and `network` are permission
   categories with no producer.

## What the app currently claims and does not do

Found while mapping. Each of these is a lie shipped to a user or a model, and
each is cheaper to fix than to explain.

1. **The `cowork` system prompt promises a browser.** `system-prompt.ts:147-150`
   tells the model it is "operating a web browser" and to "prefer the browser
   over guessing… screenshotting when layout matters". There is no browser tool.
   The model is told to use a capability it does not have, in the one mode whose
   whole reason for existing is capabilities.
2. **`READ_ONLY_TOOLS` lists four tools that do not exist** — `web_search`,
   `web_fetch`, `todo_read`, `memory_read` (`gate.ts:79-83`). A read-only
   allowlist that names absent tools is a permission surface nobody can audit.
3. **"Always allow" is not always.** The button on an approval card writes
   nothing: `allowSuggestion` is returned by the gate, rendered by
   `approval-card.tsx`, and then dropped. It behaves exactly like "Allow once",
   while promising the opposite.
4. **Three permission limits are shown in Settings and never enforced**:
   `maxRuntimeSeconds`, `maxSpendUsd`, `noQuestionsMode` (`schema.ts:173-187`).
   Only `maxSteps` reaches the loop.

## Plan

Ordered so each step is independently shippable and independently tested.

### Step 1 — stop the lies

- Derive the capability list the model is given from the registry that actually
  serves it, instead of a hand-written sentence per mode. The browser claim
  becomes conditional on a browser tool existing, which today means never.
- Delete the four stale `READ_ONLY_TOOLS` entries, and add a test that fails if
  the set and the registry ever drift apart again.
- Persist "Always allow" into the mode's allow-list.
- Enforce `maxRuntimeSeconds` and `maxSpendUsd` in the loop, next to the existing
  `maxSteps` check.

### Step 2 — extension manifests

`packages/core/src/extensions/`, zod-validated, with the fields the brief asks
for: `id`, `name`, `description`, `icon`, `resources`, `contributions`,
`lifecycle`, enablement conditions, `defaultEnabled` / `defaultHidden`, and
`platforms`.

- `manifest.ts` — the schema, and a validator that collects *all* problems
  rather than throwing on the first.
- `registry.ts` — discovery, dedup by id (last-wins with a reported conflict),
  platform filtering, enablement-condition evaluation, enable/disable, and a
  change subscription.
- `contributions.ts` — turns a validated manifest's `contributions.tools` into
  `Tool`s and hands them to the existing `ToolRegistry`. This is the "same
  underlying capability system" requirement: an extension tool and a built-in
  tool are indistinguishable to the loop and to the permission gate.
- The built-in file/shell/git tools get an equivalent manifest, so built-ins and
  third-party go through one path.

### Step 3 — skills

A skill is a named, described, configured, toggleable instruction pack.

- `skills.ts` — load from disk, validate, dedup, enable/disable, resolve
  configuration against declared defaults.
- Skills reach the model through a new `SystemPromptInput.skills` field, so
  they compose with the existing prompt rather than around it.
- The UI renders whatever the registry reports. No skill is named in a component.

### Step 4 — connections

One inventory, many sources. The brief is explicit that this must not become two
systems.

- `connections.ts` — a single `Connection` shape covering built-in capabilities
  and MCP servers, deduped by id so a configured server shadows the built-in of
  the same name rather than appearing twice.
- Real MCP client: `initialize` → `notifications/initialized` → `tools/list` →
  `tools/call`, over JSON-RPC 2.0, transport-agnostic and unit-tested.
- HTTP transport over the host's `fetch`, which is already routed through Rust.
- stdio transport over a new Rust port, because the app deliberately has no
  `tauri-plugin-shell` and a long-lived pipe is exactly the thing that port
  exists to provide.
- Discovered MCP tools become extension contributions, so they inherit the same
  registry, the same permission gate and the same approval cards.

### Step 5 — ship cowork

Remove `cowork` from `UNSHIPPED_MODES` once its prompt is derived from real
capabilities. It is already schema-complete and every tool already declares it.

## Constraints held throughout

- No `any` unless unavoidable; no casts to silence a type error.
- No mock standing in for a real implementation. Where a transport is not
  implemented, the connection reports itself unavailable rather than pretending.
- Diffs stay focused; no unrelated refactors.
- Every step ends with `pnpm verify` green and is committed on its own.
