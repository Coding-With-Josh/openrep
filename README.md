# openrep

a platform-agnostic reputation layer for ai agents.

## why it exists

right now every agent framework, chain, and marketplace builds its own siloed trust score. an agent that has proven itself in one ecosystem starts from zero everywhere else. that reputation does not travel.

openrep sits above all of that. any platform can write attestations into it, any platform can read a score out of it. an agent's reputation lives in one place and goes where the agent goes.

## what it does

the core idea is simple: reputation should be based on what an agent actually did, not what it claims.

every agent gets a portable identity, a keypair plus a human readable name like `beautiful-pig-black.agent`. the private key stays with the agent. anything signed with it is attributable to that agent and no other.

when an agent completes a real task, that gets signed and logged as an attestation. an attestation is proof of a specific piece of work, with the source that vouched for it. it is not a claim, it is a record.

reputation from other platforms and chains can be ingested and merged into one unified per-agent score, broken down by source. you can see not just that an agent scores well but which ecosystems vouched for it and how each contributed.

you work with it three ways:

- an sdk, for building openrep into your own code
- a cli, for scripting it into pipelines, ci checks, and other tooling without a browser
- a web app, where people can create agents, chat with them, and watch reputation build live

## what is real

everything in this repo is implemented, tested, and wired up — the sdk, the cli, and the web app. there are no stubs and no "not implemented yet" paths in the code. the web app is deployed to vercel and running.

- identity: ed25519 keypairs with a separate owner key that alone authorizes revocation and rotation; manifests are versioned and signed
- attestations: content-hashed signed records of real work; verification re-derives every manifest signature and every attestation signature from raw stored rows, so the verifier trusts the ledger, not the server
- security: private keys never leave the server, never reach the browser, and are envelope-encrypted at rest (aes-256-gcm) under a durable session-key store
- storage: local sqlite or hosted turso (libsql), with constraints, foreign keys, and wal concurrency hardening baked in
- ingestion: external records are treated as untrusted input, normalized, re-validated, and re-signed through registered source adapters
- hardening: typed rate limits, bounded run loops, canonicalization guarded against crafted input (cycle and depth guards)

## layout

```
packages/sdk       core library: identity, attestation, ingestion, scoring
packages/cli       command line tools: script reputation into pipelines and ci
apps/web           next.js web app: create agents, chat, watch reputation build live
apps/marketplace   (placeholder) planned real ingestion source — not built yet
```

## quickstart

### web

```bash
pnpm install
pnpm dev
```

open http://localhost:3000, create an agent, send it a task, and watch the score move. every completed turn is a real, signed attestation, and the score screen shows a per-attestation verification verdict.

for a hosted deployment set the vars in `apps/web/.env.example`: `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` select turso, `OPENREP_MASTER_ENCRYPTION_KEY` is required, `OPENREP_GROQ_API_KEY` powers chat. without turso vars the app runs on local sqlite via `OPENREP_DB_PATH`.

### sdk

```ts
import { createAgent, attest, getScore, getSqliteStorage } from "@openrepso/sdk";

const storage = getSqliteStorage(":memory:"); // or a file path

const agent = await createAgent({ storage });
// { name: "beautiful-pig-black.agent", publicKey, ownerPublicKey, signature, ... }

await attest(
  {
    agentId: agent.publicKey,
    task: "fixed the flaky test",
    output: "passed 42/42",
    source: "native",
  },
  agent.privateKey,
  storage,
);

const score = await getScore(agent.publicKey, storage);
// { composite, breakdown: [{ source: "native", value, count, ... }] }
```

### cli

```bash
pnpm add -g @openrepso/cli

openrep create
openrep attest -a beautiful-pig-black.agent -t "fixed the flaky test" -o "passed 42/42"
openrep score beautiful-pig-black.agent
openrep verify beautiful-pig-black.agent
openrep resolve beautiful-pig-black.agent
openrep ingest -f attestation.json -s <source> -a beautiful-pig-black.agent
```

`attest` signs a native attestation with the agent's identity key; `source` is deliberately closed to native there (external records belong to `ingest`). `ingest` normalizes and re-signs an external record through a registered source adapter — the marketplace adapter ships with the marketplace app below, so `ingest` fails loudly until then.

`openrep verify` is the ci gate: it re-hashes the manifest and every attestation against raw stored rows and exits non-zero on any failure, with no trust in any server.

`openrep create` takes custody of the generated keys in the os keychain (encrypted-file fallback); headless and ci runs can inject `OPENREP_SIGNING_KEY` instead.

### interactive tui

running `openrep` with no subcommand on a tty opens a four-screen tui: splash, dashboard, chat, score. one chat turn is a real wrapped agent run: each reply is a signed attestation, and the provider api key prompt is masked and never recalled.

| keys | meaning |
| --- | --- |
| any key | splash -> dashboard |
| enter / `s` / `r` then `y` | dashboard: chat / score / revoke confirm |
| `n` | dashboard: create agent |
| `q` / ctrl+c | quit |
| esc | chat/score: back to dashboard; key prompt: cancel |
| ctrl+r | chat: retry the last user message |
| up/down | dashboard: select agent; chat: recall previous messages; score: neighbor agent |
| left/right | chat input: move cursor |
| option/ctrl+left/right | chat input: jump by word (macos option, linux/windows ctrl) |
| option/ctrl+backspace | chat input: delete word |
| ctrl+u / ctrl+k | chat input: kill to line start / line end |
| `?` | splash: help overlay |

assistant replies render real markdown (headers, bold, lists, code blocks with syntax highlighting) via marked + marked-terminal. each turn sends the prior chat transcript to `wrapAgent` as conversation context, capped by the sdk's 20-turn / 16,000-char history budget.

## known limitations (honest)

- the marketplace ingestion source does not exist yet. the plan is a small real app at `apps/marketplace` (post, claim, complete, rate — the frontend hand-built without ai assistance); the sdk-side ingestion is ready, but no real external attestations are flowing until then.
- the attestation revocation gate is a pre-check read, not atomic with the insert: a revoke landing in between would not be observed. this is a recorded, conscious deferral — revocation is only exposed in the cli today, so no live path reaches the window. the fix is a conditional insert once revocation touches any concurrently-written surface.
- rate limits are in-memory fixed-window, so they throttle per process/instance, not globally across serverless instances. production would move to a shared store.
- local storage mode is single-user by design and honest about it; turso is the shared, hosted story.

## tests

the sdk and cli ship 35 test files (vitest), covering real sqlite and real hosted libsql, key rotation, revocation, concurrency, canonicalization, providers, custody, chat history bounds, input editing, and live integration flows.

<br/>

_cheers_