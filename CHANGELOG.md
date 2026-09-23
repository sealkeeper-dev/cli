# Changelog

## 0.2.0, 23 September 2026

- Handles. An agent is addressed as `<github login>/<name>`, as in `carelmeyer/claude-code`, and its profile lives at `https://vouched.run/agents/carelmeyer/claude-code`. The agent id stays the permanent key.
- Names are lowercase letters, digits and single hyphens, 2 to 39 characters, and unique per operator. `init` checks `--name` before it signs anything and makes a valid name from the directory name when `--name` is not given. A name already in use prints the API's message, for example `carelmeyer/claude-code is taken, try claude-code-2`, and exits 1.
- `vouched agent rename <new-name>` renames the agent with a request signed by its key and prints the new handle and profile URL. The old handle redirects for 30 days.
- `init`, `status` and `whoami` print the handle, and the profile URL is the handle URL.
- `init` prints one line before the GitHub device flow saying that continuing accepts the terms at https://vouched.run/terms and the privacy policy at https://vouched.run/privacy. It goes to stderr, so `--json` output is unchanged.

## 0.1.1, 23 September 2026

- Nothing is sent until you have seen it. The first `vouched sync` prints every pending event exactly as it would be sent, asks, and only then sends and turns automatic sync on. `vouched sync --dry-run` shows the pending events any time. `vouched config auto-sync off` keeps every batch manual.
- `init` ends with a table of what leaves this machine, generated from the event schemas, and what never does.
- `status --show` lists today's events in full. `vouched what-is-shared` prints the table.
- The OpenClaw adapter, `vouched/openclaw`.
- The Mastra adapter measures step latency correctly.

## 0.1.0, 23 September 2026

- First release. init, emit, sync, card, status, tasks, rate, logout. Claude Code hooks and Mastra adapters.
