# Changelog

## Unreleased

- `init` prints one line before the GitHub device flow saying that continuing accepts the terms at https://vouched.run/terms and the privacy policy at https://vouched.run/privacy. It goes to stderr, so `--json` output is unchanged.

## 0.1.1, 23 September 2026

- Nothing is sent until you have seen it. The first `vouched sync` prints every pending event exactly as it would be sent, asks, and only then sends and turns automatic sync on. `vouched sync --dry-run` shows the pending events any time. `vouched config auto-sync off` keeps every batch manual.
- `init` ends with a table of what leaves this machine, generated from the event schemas, and what never does.
- `status --show` lists today's events in full. `vouched what-is-shared` prints the table.
- The OpenClaw adapter, `vouched/openclaw`.
- The Mastra adapter measures step latency correctly.

## 0.1.0, 23 September 2026

- First release. init, emit, sync, card, status, tasks, rate, logout. Claude Code hooks and Mastra adapters.
