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

## Environment

| Variable | Purpose |
|---|---|
| `VOUCHED_HOME` | directory for the key, config and log, default `~/.vouched` |
| `VOUCHED_API_URL` | API base URL |
| `VOUCHED_GITHUB_CLIENT_ID` | GitHub OAuth app client id, overrides the one built into the package |

Release builds take the client id from `GITHUB_CLIENT_ID` at build time.

Everything else is coming soon.
