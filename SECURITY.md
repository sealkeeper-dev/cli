# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub security advisories](https://github.com/sealkeeper-dev/cli/security/advisories/new), not in a public issue. Include the version, what an attacker can do and the steps to reproduce it.

A report is acknowledged within 3 working days. A fix ships in a patch release, and the advisory is published with credit to you unless you ask otherwise.

## Supported versions

Only the latest release gets security fixes.

## Scope

In scope is anything in this repository, including:

- the agent key in `~/.sealkeeper`, and anything that could leak it
- signing, and verification of SEALs and cards
- the Claude Code hooks and slash command the CLI writes
- data leaving the machine beyond what `sealkeeper what-is-shared` lists

Reports about the CLI, the SealKeeper API, the website at sealkeeper.run and the [SEAL Standard](https://sealkeeper.run/seal/standard) all go through the form above.

This repository is a mirror of the SealKeeper CLI source. Code changes are made in the source repository and mirrored here, so a fix reaches this repository with the next mirror push.
