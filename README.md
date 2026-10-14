# HydraDB DeepSeek Harness Plugin

Persistent, cross-session memory for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`), powered by [HydraDB](https://hydradb.com).

It recalls relevant context before each turn, syncs your workspace docs into
HydraDB, and captures conversations as durable memory, over the same shared
engine (`scripts/plugin.mjs`) as the HydraDB Claude Code / Codex / OpenClaw plugins.

## What's dsh-specific here

- **Entry module:** `index.js`, an ordinary [Cordis](https://github.com/deepseek-ai/deepseek-harness)
  plugin (`export const name` + `export function apply(ctx)`). dsh mounts it by
  package name and calls `apply` with the plugin `ctx`; it registers listeners
  on the harness interception seams over the shared engine.
- **Env prefix:** per the shared client contract, this client reads the canonical
  `HYDRADB_*` names plus the `HYDRA_DEEPSEEK_*` prefix (see `CONTRACT.md`).
- **Skills:** the shared HydraDB skills under `skills/` for manual recall/ingest.

## Seams

| dsh extension point | Engine action |
|---|---|
| `agent/created` | sync workspace docs into HydraDB when a session opens |
| `agent/pre-step` (turn's first step) | recall relevant memory/knowledge and **prepend it to the step messages** |
| `tools/post-execute` (file-writing tools) | incremental workspace sync |
| `session/event` → `turn/end` | capture the completed turn |

Prompt-time auto-recall (`agent/pre-step`) and workspace sync work out of the box.
The `agent/pre-step` waterfall is cooperative: the plugin awaits `next()` and only
prepends a user-role context message to the downstream `enter` decision, so it
composes with other pre-step listeners instead of overriding them.

## Prerequisites

- Node.js >= 18
- A HydraDB account: API key + database ([hydradb.com](https://hydradb.com))
- DeepSeek Harness (`dsh`)

## Install

This package ships as a dsh **bundle** (`dsh.bundle` + `cordis.patch.yml`), so
`dsh plugin add` installs and wires it as a profile layer in one step:

```sh
dsh plugin --profile <name> add dsh-hydradb
```

dsh appends it to the profile's `dsh.profile.bundles` and inserts the `hydradb`
plugin row automatically - no manual `cordis.patch.yml` editing. To pass config
inline instead of via the environment, add a `config:` block to the bundle's
`cordis.patch.yml` (see `dsh.config.example.yml` for the `--patch` overlay form).

Credentials come from the plugin config (`api_key`, `database`, optional
`collection`/`base_url`) or the environment:

```bash
export HYDRADB_API_KEY="your-api-key"
export HYDRADB_DATABASE="your-database"
# dsh-prefixed names also work: HYDRA_DEEPSEEK_API_KEY / HYDRA_DEEPSEEK_TENANT_ID
```

The default search mode is `memory`; set `HYDRADB_SEARCH_MODE=both` if you also
want synced workspace knowledge to auto-recall.

## Usage

- **Automatic recall** runs before each turn's first step via `agent/pre-step`
  and prepends relevant memory/knowledge to the step messages.
- The shared skills provide manual `query` / `ingest` / `doctor` / `setup` /
  `last-recall` actions; the contract's canonical slash form is `/hydradb-query`,
  `/hydradb-ingest`, `/hydradb-list`, `/hydradb-inspect`, `/hydradb-delete`.

## Configuration

Config keys, environment overrides, and capture/search/ingest modes are identical
to the other HydraDB plugins - see `config.example.json` and `CONTRACT.md`.

## Verified

Tested against DeepSeek Harness (`dsh`) 0.2.0-rc.2: the bundle installs via
`dsh plugin add`, registers as a profile layer, and its `apply` seams activate
cleanly. A live `dsh headless` turn (OpenRouter provider) answered a question
from HydraDB memory recalled and injected through `agent/pre-step`.

## License

[Apache 2.0](LICENSE) - Copyright (c) 2026 HydraDB
