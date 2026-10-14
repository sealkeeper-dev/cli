# SEAL reader fixtures

Test inputs for a SEAL reader, each with the answer a correct reader gives. They cover a valid SEAL, an expired one, a bad signature, an unknown key, a version 4 SEAL with a handshake beside it, and every 404, 400 and 429 answer the SEAL read gives. A reader should treat every broken SEAL and every one of those answers as no SEAL.

The format is in the [SEAL Standard](https://sealkeeper.run/seal/standard) and the [format reference](../docs/seal.md). [Build a SEAL reader](https://sealkeeper.run/docs/seal-reader) walks through a reader from the first fetch.

## A fixed test key and a fixed clock

Every SEAL here is signed with a fixed test key, kid `fixture-1` in `keys.json`, never the production key. The private test keys are fixed values that sign these fixtures and nothing else, so never trust `fixture-1` outside a test. Ed25519 signing is deterministic, so the files are the same bytes every time they are made.

Nothing here verifies against the live keys at `https://sealkeeper.run/.well-known/seal.json`. A live SEAL lasts 24 hours, and a fixture must hold still.

Every time derives from one clock, FIXTURE_NOW, `2026-10-01T12:00:00Z`, Unix 1790856000.

## Two clocks

A reader that pins its clock to FIXTURE_NOW gets the pinned answers. A reader on the real clock gets the now answers, the same at any time from `2026-10-02T12:00:00Z` on. Where the two differ, both are given. `seal verify --at` and the `at` field of `POST /v1/seal/verify` check a SEAL at a time you name, and a valid answer then adds `lapsed`, true when the SEAL has expired since.

A handshake is always checked against the real clock, and one with a nonce must be signed within 300 seconds of it. So the handshake reads Matches at FIXTURE_NOW and stale at any later time, even beside a SEAL checked with `--at`.

## The files

- `keys.json`. The key document, in the shape of `/.well-known/seal.json`, with the one test key.
- `agent.json`. The fixture agent, its id `gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q`, its did:key, its handle `alice/fixture` and the fingerprint hash the version 4 SEAL carries.
- `seals/`. Each file is a bare compact JWS with no trailing newline, so the SHA-256 of the file is the hash of the SEAL.
- `handshake/handshake.txt`. A handshake signed by the fixture agent at FIXTURE_NOW, with nonce `fixture-nonce` and verifier `fixture-verifier`.
- `reads/`. The answers of `GET /v1/agents/<agent id>/seal` besides the SEAL, each `{ status, headers, body }` as the API writes it.
- `index.json`. Every case, machine readable, with its file, its command, its exit code and the answer at each clock.

## The cases

The answers are those of `POST /v1/seal/verify` against `keys.json`, and the exit codes those of `sealkeeper seal verify`. index.json has each answer in full.

| Case | File | Pinned at FIXTURE_NOW | Now |
|---|---|---|---|
| v1-valid | `seals/v1-valid.txt` | valid, `lapsed` true, exit 0 | `expired`, exit 1 |
| v1-expired | `seals/v1-expired.txt` | `expired`, exit 1 | `expired`, exit 1 |
| v1-bad-signature | `seals/v1-bad-signature.txt` | `bad_signature`, exit 1 | `bad_signature`, exit 1 |
| v1-unknown-kid | `seals/v1-unknown-kid.txt` | `unknown_kid`, exit 1 | `unknown_kid`, exit 1 |
| v4-valid | `seals/v4-valid.txt` | valid, `lapsed` true, exit 0 | `expired`, exit 1 |
| handshake | `handshake/handshake.txt` beside `seals/v4-valid.txt` | handshake `matches`, against `seal`, proof `verifier` | handshake `stale`, exit 1 |

The handshake cannot read Matches through the CLI, which checks a handshake against the real clock. A reader that pins its own clock to FIXTURE_NOW gets Matches.

| File | Request | Status | What it says |
|---|---|---|---|
| `reads/not_found.json` | `GET /v1/agents/7UkoxijRwsbq6QM4kFmVYSlZJzpcY_k2NsFGFKyHN9E/seal` | 404 | No agent has this id. |
| `reads/withheld.json` | `GET /v1/agents/gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q/seal` | 404 | SealKeeper holds the agent for cause, reason the class only. |
| `reads/no_recent_check.json` | `GET /v1/agents/gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q/seal` | 404 | A listed agent with no recent OK task check. It is no hold. |
| `reads/checking.json` | `GET /v1/agents/gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q/seal` | 404 | A listed agent SealKeeper is still checking, or one no longer listed. |
| `reads/no_seal.json` | `GET /v1/agents/gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q/seal` | 404 | The SEAL is withheld because the agent has been dormant. |
| `reads/renamed.json` | `GET /v1/agents/alice/old-fixture/seal` | 404 | The handle route only. The handle was given up, and the agent is now at handle. |
| `reads/validation_failed.json` | `GET /v1/agents/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/seal` | 400 | A malformed agent id. Fix the request rather than retry it. |
| `reads/rate_limited.json` | `GET /v1/agents/gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q/seal` | 429 | Over the public read limit. Retry-After is the whole seconds to wait, and its value varies. |

Branch on `error.code`, never on the status alone, since several answers share 404. A 429 carries a `Retry-After` header with the whole seconds to wait.

## Run them

From the root of this repository. The commands name `sealkeeper@latest`, since a bare `npx sealkeeper` here runs this repository's own unbuilt copy. `--at` needs the CLI release after 0.5.5. A SEAL at the pinned clock and at the real one.

```sh
npx sealkeeper@latest seal verify - --keys fixtures/keys.json --at 2026-10-01T12:00:00Z < fixtures/seals/v1-valid.txt
npx sealkeeper@latest seal verify - --keys fixtures/keys.json < fixtures/seals/v1-valid.txt
```

The first prints `valid SEAL at 2026-10-01T12:00:00.000Z` and exits 0, the second prints `broken SEAL: expired <n> minutes ago` and exits 1. The CLI writes each reason with spaces, such as `broken SEAL: bad signature`. The handshake beside the version 4 SEAL, at the real clock.

```sh
npx sealkeeper@latest seal verify - --keys fixtures/keys.json --at 2026-10-01T12:00:00Z --handshake "$(cat fixtures/handshake/handshake.txt)" --nonce fixture-nonce --for fixture-verifier < fixtures/seals/v4-valid.txt
```

It prints `valid SEAL at 2026-10-01T12:00:00.000Z` for the SEAL, then `handshake refused: signed outside its window`, and exits 1.

`POST https://api.sealkeeper.run/v1/seal/verify` checks against the production keys, never `keys.json`. So every fixture SEAL answers `{"valid":false,"reason":"unknown_kid"}` there, which is itself a case a reader must handle.

```sh
curl -s -X POST https://api.sealkeeper.run/v1/seal/verify -H 'content-type: application/json' -d "{\"seal\":\"$(cat fixtures/seals/v1-valid.txt)\"}"
```

## SEAL reference

The SEAL reference of `seals/v1-valid.txt`, as index.json has it under `sealReference`.

```
sealkeeper:seal:1:subject:35886f79f3a6e302e52f05e7fe10c3e9253605498052dc63c29ff0a6e5d821be:https://api.sealkeeper.run/v1/agents/gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q/seal
```

## Versions

Production issues version 1 today, and the published `@sealkeeper/schema` reads versions 1 to 4. So the fixtures carry version 1 and version 4. A version 5 fixture follows with the schema release that reads it.
