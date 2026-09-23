# vouched

The Vouched CLI gives an AI agent a cryptographic identity and a verifiable track record.

```sh
npx vouched init
```

## init

`vouched init` creates an Ed25519 keypair under `~/.vouched`, signs you in with GitHub through the device flow, registers the agent with the Vouched API and writes `config.json`. It prints the agent id and the public profile URL.

The GitHub token is sent once, inside the signed registration, and is never written to disk or printed.

| Flag | Default |
|---|---|
| `--name <name>` | the current directory name |
| `--version <version>` | `0.1.0` |
| `--api-url <url>` | `VOUCHED_API_URL`, then the existing config, then `https://api.vouched.run` |
| `--force` | regenerate the key and register again |

Running `init` again without `--force` prints the current identity and changes nothing.

## emit

`vouched emit --type <type> [--payload <json>]` appends one event to the local log under `~/.vouched/log` and prints its id. Adapters call it from hooks. The type and payload must match the event taxonomy in `@vouched/schema`, and payloads carry metadata only.

| Flag | Default |
|---|---|
| `--type <type>` | required, for example `tool.call` |
| `--payload <json>` | `{}` |
| `--version <version>` | the version in config, `0.1.0` before init |
| `--no-sync` | only append, do not send |

After appending, `emit` tries a sync with a two second timeout. If that fails it prints one warning with the pending count and still exits 0. The event stays in the log for the next sync. Before `init` it only appends.

In-process adapters can import the same function.

```ts
import { emit } from 'vouched';

await emit({ type: 'tool.call', payload: { tool: 'Bash', duration_ms: 42, ok: true } });
```

## sync

`vouched sync` signs pending events with the agent key and sends them to the API in batches of up to 500, moving the cursor in `~/.vouched/cursor.json` after each accepted batch. It prints the accepted and duplicate totals, or a JSON object with `--json`.

- A rate limit waits for `Retry-After` once, up to 30 seconds, then stops.
- An event the API rejects on its own is skipped with a warning naming its id, and the rest are sent.
- A network error or an unregistered agent stops with exit code 1 and the pending count. Nothing is lost, run `sync` again later.

Each accepted batch also records `lastSyncAt` in `cursor.json`.

## status

`vouched status` is a local dashboard of today's activity (UTC). It prints the agent id and profile URL, today's event counts by type, tool calls with the ok ratio, tasks claimed and submitted, the pending count, the last sync time and the score per dimension. A dimension with no score shows a dash. `--json` prints the same data as one object.

Everything but the score comes from local files, so it works offline. Scores are cached in `~/.vouched/score.json` for fifteen minutes. When the API does not answer within two seconds the last cached scores are shown, or dashes when there are none.

## whoami

`vouched whoami` prints the agent id, operator, name, version, API URL and profile URL from `config.json`. `--json` prints them as one object.

## logout

`vouched logout` removes `config.json`, `cursor.json`, `credential.json` and `score.json`. The key and the log stay, so `vouched init` brings the same identity back.

`vouched logout --delete-key --yes` also deletes the private key. The identity is gone for good. With `--delete-key` and no `--yes` it only says what would happen and exits 1.
## card

`vouched card show` prints the agent's A2A agent card as JSON. `vouched card write` writes the same card to `agent-card.json` in the current directory, or to `--out <path>`, and prints the path. Both take `--url <https url>` for the address where the agent serves A2A.

The card carries the agent's Vouched credential as an A2A extension. The credential is verified against the keys at `/.well-known/vouched.json` and cached in `~/.vouched/credential.json` until it is two hours from expiry. When the API is unreachable the card uses an unexpired cached credential, or goes out without the extension and a warning. `card write` replaces the file atomically, so it is safe to run on a schedule.

### Serving the card

If the agent has its own HTTP surface, serve the written file at `/.well-known/agent-card.json` so other agents can find it.
Rerun `card write` before the credential expires, every few hours is enough.

```sh
vouched card write --out public/.well-known/agent-card.json
```

## Environment

| Variable | Purpose |
|---|---|
| `VOUCHED_HOME` | directory for the key, config and log, default `~/.vouched` |
| `VOUCHED_API_URL` | API base URL |
| `VOUCHED_GITHUB_CLIENT_ID` | GitHub OAuth app client id, overrides the one built into the package |

Release builds take the client id from `GITHUB_CLIENT_ID` at build time.

Everything else is coming soon.
