# openrep, build checklist

this is the working task list for taking the workspace from its current stubbed state to a fully working demo. tasks build the real thing: real keypair generation, real signing, real model api calls, real storage, real score calculation. the only data that is legitimately mocked is external cross platform attestations, which are sample input files because there are no live external platforms to pull from. those sample files are labeled as sample data, they are not a shortcut on our own logic.

## phase 0, types and security model

- [x] define production-grade types and interfaces, including key custody and security model: domain split types in packages/sdk/src/types/ (identity, security, attestation, sources, score, storage, errors, providers, api, activity, config), cli and web types, key custody policy (master key from env, aes-256-gcm envelope encryption, session key store, raw keys never persisted), api contracts that never expose private keys, and updated stub signatures
- [x] write unit tests for the finalized types where a test is meaningful: the canonical id decision and permissions union are exercised by `test/agent.test.ts` (agents are keyed and looked up by public key, and out-of-union permissions are rejected). the env config result shape test stays pending until `loadEnvConfig` is implemented
- [x] wire up a test runner in `packages/sdk` (vitest 5, run with `pnpm --filter @openrep/sdk test`)

## phase 1, sdk core: identity

- [x] add a keypair dependency to `packages/sdk`: `@noble/ed25519` v3 (async, webcrypto backed), not `@noble/curves` or node `crypto`
- [x] implement keypair generation inside `createAgent` via `keygenAsync`, returned as lowercase hex public and private keys
- [x] implement human readable name generation: exported word lists (`ADJECTIVES`, `NOUNS`, `COLORS`, 36 words each) into the `adjective-noun-color.agent` shape, csprng driven, auto generated when no name is given
- [x] implement manifest signing: deterministic `canonicalize` (src/canonical.ts) of the six signed fields, signed with the ed25519 private key, strict rfc8032 verification
- [x] implement `createAgent(options)` composing keypair generation, name generation, manifest signing, and persistence through the injected `StorageAdapter` (defaults: memoryPointer null, permissions `["attest:self"]`, retry cap 10)
- [x] define the name-uniqueness storage contract: a unique constraint on `agents.name` is the source of truth (closes the check-then-write race); the optimistic `getAgentByName` read is an optimization only; adapters surface constraint violations by throwing an error with `code` exactly `"DUPLICATE_NAME"`
- [x] reject caller supplied names that collide with `DUPLICATE_NAME` (never silently rename) and exhausted auto-generation with `NAME_GENERATION_EXHAUSTED`
- [x] add a `verifyManifest(manifest)` helper (async) that re-canonicalizes the manifest fields and checks the signature against its public key, shape-validating every field first
- [x] write unit tests that create an agent, verify the returned manifest signature, and cover the constraint retry, exhaustion, generic storage failure, and invalid input paths (`test/agent.test.ts`)
- [x] add `INVALID_INPUT` and `KEY_GENERATION_FAILED` to the sdk error code vocabulary so every createAgent failure path has a specific, typed code
- [x] two-keypair split and schema version bump: `createAgent` now generates a separate owner keypair (`ownerPublicKey`/`ownerPrivateKey`) alongside the identity keypair, `MANIFEST_VERSION = 2` adds `ownerPublicKey` to the signed manifest, and `verifyManifest(manifest, storage)` branches on the signed version so a legacy v1 manifest still verifies against its exact original six fields (pinned by a byte-identical v1 fixture test). only the identity key signs attestations; only the owner key can revoke
- [x] implement `revokeAgent(request, storage)` in `src/revocation.ts` with the full ordered authorization chain: shape (agentId 32-byte hex, signature 64-byte hex, iso timestamp), `AGENT_NOT_FOUND` for a missing record, `OWNER_KEY_MISSING` for a legacy row with no owner key (fail closed), `UNAUTHORIZED_REVOCATION` for a signature that does not verify against the stored owner key, `STALE_REVOCATION_REQUEST` outside the symmetric five minute window, idempotent success for an already-revoked agent (with the storage write firing exactly once), and the persistent `revokedAt` stamped sdk-side only after full authorization
- [x] add a dumb `revokeAgent(agentId, revokedAt)` UPDATE to the storage adapter: `UPDATE agents SET revoked_at = ? WHERE public_key = ?`, throws `AGENT_NOT_FOUND` on zero rows, never re-verifies signatures (the sdk is the single enforcement point), and the storage upgrades an `agents` table missing `owner_public_key`/`revoked_at` via the same guarded `ALTER TABLE ADD COLUMN` pattern as the idempotency column
- [x] gate attestation on revocation: `attest` reads the stored agent record before any key derivation or signing (`AGENT_REVOKED` when revoked, `AGENT_NOT_FOUND` when unknown, fails closed as `STORAGE_WRITE_FAILED` on a read failure), and `verifyAttestation(attestation, storage)`/`verifyManifest(manifest, storage)` fail a revoked signer with reason `key revoked`. the attest() gate is a pre-check, not atomic with the insert; the read-then-write window is documented in technical.md and deferred to the wal/concurrency task below
- [ ] implement key rotation. distinct from revocation: rotation silently re-keys an existing agent, which is not implemented. `KeyRotationRecord` is typed and the schema carries no breaking change, but true rotation remains an open production gap for a leaked identity key when revocation is not the desired response
- [ ] implement aes-256-gcm session key encryption and the `SessionKeyStore` so keys can persist across multi-turn sessions. explicitly out of scope for this pass (keys are memory-only now), but required before `createAgent` is wired into the chat ui

## phase 2, sdk core: storage

- [x] choose the local store: the node built-in `node:sqlite` (`DatabaseSync`, requires node `>= 22.13` with the sdk `engines` field bumped), so no sqlite dependency is added to `packages/sdk`
- [x] create the storage module `packages/sdk/src/storage/sqlite.ts` that opens the database path passed in (never hardcoded; the path will come from `EnvConfig.databasePath` via `loadEnvConfig` at the call site), with an idempotent `CREATE TABLE IF NOT EXISTS` schema bootstrap at construction and a memoized `getSqliteStorage` for one open connection per path per process
- [x] create the `agents` table (row_id, unique name, unique public_key, owner_public_key nullable, memory_pointer, permissions json, created_at, manifest_version, signature, revoked_at nullable) where the unique constraint on name is the enforceable source of truth behind createAgent's collision handling (the sdk's optimistic read is an optimization only). `owner_public_key` and `revoked_at` are nullable so legacy rows without an owner key and never-revoked agents are represented honestly, and a runtime assertion that a record carrying a private key (identity or owner) is refused before any sql runs. the two revocation columns are added to pre-existing databases by the guarded `ALTER TABLE ADD COLUMN` in the upgrade note below
- [x] create the `attestations` table (row_id, unique id, agent_id foreign key to agents.public_key enforced per connection, task, output, tools_used json, source, content_hash, signature, signed_by, timestamp, schema_version)
- [x] add idempotency support to the storage layer: an optional `idempotency_key` column on `attestations` (additive for fresh databases, guarded `ALTER TABLE ADD COLUMN` for pre-existing files since sqlite has no `ADD COLUMN IF NOT EXISTS`), a composite unique index on `(agent_id, idempotency_key)` that is the authoritative guard behind `attest`'s dedup contract, `getAttestationByIdempotencyKey(agentId, idempotencyKey)` for the optimistic read, and translation of the composite violation into `DUPLICATE_IDEMPOTENCY_KEY`. the cross-process hardening note below is cited here on purpose: this constraint covers in-process races and retries; the WAL task covers multi-process overlap
- [x] create the `registered_sources` table (source_name primary key, registered_at, trust_weight)
- [x] implement `saveAgent(record)` to insert a signed manifest, translating the schema name constraint violation into an error with `code` exactly `DUPLICATE_NAME` (public key collisions surface as the distinct `DUPLICATE_PUBLIC_KEY`)
- [x] implement `getAgent(agentId)` (canonical id, named `getAgent` per the finalized StorageAdapter interface) and `getAgentByName(name)` reads, returning null on not-found, never throwing
- [x] implement `saveAttestation(record)` to append a signed attestation to the ledger, translating foreign key violations for nonexistent agents into `AGENT_NOT_FOUND`
- [x] implement `getAttestations(agentId, { cursor, limit })` to return an agent's history for scoring and verify, newest first, cursor paginated over the immutable row_id so rows inserted between page loads never shift or duplicate returned pages
- [x] confirm the public key lookup path: `getAgent(agentId)` returns the full record including `publicKey`, which is what signing and verify consume (the separate `getAgentPublicKey` method from the earlier draft is not in the finalized interface)
- [ ] make the storage path the single shared access point the sdk, cli, and web app all use (adoption by the cli and web app lands in phases 6 and 7)
- [x] write real sqlite tests: `test/storage.test.ts` covers round trips, every error code, the foreign key failure, cursor pagination, sql-injection shaped values, and the private key backstop against a fresh `:memory:` database per test; `test/integration.test.ts` runs the real `createAgent` against the real adapter, including three concurrent creates resolving through the actual unique constraint
- [ ] harden the storage adapter for cross-process concurrency before the demo: `PRAGMA journal_mode = WAL` on file-backed databases so readers never block writers, plus a two-process contention test (web server or cli holding the file open while a second process writes). one memoized connection per process already serializes in-process requests and `busy_timeout = 5000` covers short fights, so the untested window is exactly the cross-process one

## phase 3, sdk core: attestation and capture

- [x] implement `attest(input, signingKey, storage)` (final signature, additive third parameter for persistence) that validates input at the boundary, derives the public key and rejects a signer that does not match the claimed agent (`KEY_MISMATCH`), enforces the closed source set (`INVALID_SOURCE` for anything but `native`), enforces size limits (`INPUT_TOO_LARGE`), does an optimistic idempotency read, hashes, signs, and persists. the foreign key on the insert is the backstop for a nonexistent agent and the composite idempotency index is the backstop for duplicate keys; on top of those, the revocation pass added an `AGENT_REVOKED`/`AGENT_NOT_FOUND` pre-check that reads the stored agent record before any crypto so a revoked or unknown agent (per decision D3) is rejected up front, and it resolves a `DUPLICATE_IDEMPOTENCY_KEY` save by fetching and returning the existing record
- [x] implement canonical payload hashing so attestation and verify hash the same bytes: sha-256 over `canonicalize({ task, output, toolsUsed })`, signature over the content hash bytes, `randomUUID` attestation ids, server side timestamp
- [x] harden `canonicalize` against crafted tool input: circular references rejected with a clear error (ancestor-set detection, cycle-accurate so shared sibling references still serialize), `MAX_CANONICAL_DEPTH = 6` bound, non-finite numbers and unsupported types rejected, covered by direct tests in `test/canonical.test.ts`
- [x] implement `verifyAttestation(attestation)` that recomputes the content hash and checks the signature under `zip215: false`, returning specific invalid reasons (`content hash mismatch`, `signature verification failed`) and never throwing
- [x] gate `verifyAttestation` and `verifyManifest` on revocation state: both take the `StorageAdapter` and fail a revoked signer or a manifest whose agent is revoked with reason `key revoked`, and fail closed (`agent not found`) when the storage holds no record, so revocation always wins over an otherwise valid signature
- [x] implement `wrapAgent` with explicit dependencies (`agentId`, `signingKey`, `storage`, `config`, `tools`, `apiKey`, `task`) so it records the task passed in, works against real model api calls, and captures the model's response as `output`
- [x] capture tool calls made inside the wrapped run and fold them into the attestation evidence so they are covered by the signature
- [x] make `wrapAgent` side effect on storage per call, producing one real signed attestation per run through `attest` by composition
- [x] write a unit test that runs a wrapped function and asserts a signed, persisted attestation with the correct output (and a verify round trip)
- [x] implement the provider adapter abstraction: a `ProviderClient` interface in `types/providers.ts`, `AnthropicClient` and `OpenAiClient` adapters in `src/providers/`, and a `createProviderClient` factory keyed on `config.provider`, with all provider-specific request and response parsing inside the adapters
- [x] bound the run loop: `MAX_TURNS = 10` (`TURN_LIMIT_EXCEEDED` on non-convergence) and a whole-run `MAX_RUN_MS = 120s` wall-clock budget via one `AbortController` that also aborts the in-flight provider request (`RUN_TIMED_OUT`)
- [x] gate model tool requests before execution: a tool name not in the offered definitions and implementations is `UNREGISTERED_TOOL` (never executed), and model-supplied arguments are validated against the tool's `inputSchema` by the internal structural validator before the real implementation runs (`TOOL_ARGUMENT_INVALID`)
- [x] capture a throwing tool implementation as a structured failed tool result and feed it back to the model so the run survives
- [x] only call `attest` on a converged run: every non-converged terminal state (`TURN_LIMIT_EXCEEDED`, `RUN_TIMED_OUT`, `UNREGISTERED_TOOL`, `TOOL_ARGUMENT_INVALID`, `PROVIDER_API_FAILURE`) returns a typed failure with no attestation persisted
- [x] keep the provider api key out of the captured evidence, error messages, and persisted rows: the key lives only in the adapter request header, and a dedicated test asserts it appears nowhere in results, captured tools, or storage

## phase 4, sdk core: scoring and resolution

- [x] implement `getScore(agentId, storage, options?)` from the real attestation history, not from any hardcoded value: full cursor-paginated read until exhausted, `SCORE_MAX_ATTESTATIONS` cap failing closed with `SCORE_COMPUTATION_LIMIT_EXCEEDED` (never a truncated score), zero-history agents scoring a valid `0` with an empty breakdown, unknown agents returning `AGENT_NOT_FOUND`
- [x] compute per-source breakdown from the real attestations: each entry carries `source`, `value`, `count`, and `lastUpdated` (newest timestamp per source). value = count; there is no `avgConfidence` field, the `ScoreBreakdown` type never carried one, so the documented semantics are value/count. the breakdown is returned sorted by source name for deterministic output
- [x] combine the per-source values into a single composite score: `composite = sum over sources of (count * trustWeight)`, `native` pinned to weight `1.0` with no `registered_sources` row required (and immune to a bogus native row), registered weights read from the table (non-finite/negative clamped to `0`), unregistered non-native sources visible in the breakdown but weighted `0`
- [x] implement `resolve(name, storage)` that looks up the manifest by name and returns the live `ResolvedManifest` (stored record minus `rowId`, `revokedAt` included) plus `AgentScore`, as a thin composition of `getAgentByName` + `getScore` with no scoring logic of its own (code-level proof in `test/resolve.test.ts`: getScore mocked, any direct attestation/registered-source read would throw)
- [x] write tests that write a few real attestations and assert the composite and breakdown reflect exactly those attestations: a unit matrix against a fake storage with exact sqlite cursor semantics (`test/score.test.ts`, including the cap path and the native-only no-lookup rule) and a real sqlite integration pass with a hand-computed composite, genuine multi-page reads, and the revoked-agent score behavior (`test/score.integration.test.ts`)

## phase 5, sdk core: ingestion

- [ ] create sample external attestation files (clearly labeled sample data, one per mock platform such as github and stripe)
- [ ] implement `ingest(externalAttestation)` that normalizes an external record into the native `Attestation` schema
- [ ] map the external platform `name` into the local `source` field and look up the matching local agent by name
- [ ] verify ingested records where the external record carries a usable signature, and handle unverifiable ones explicitly
- [ ] confirm that ingesting a sample external attestation changes the target agent's score and breakdown (covers the demo requirement)

## phase 6, cli

- [ ] remove the stub bodies from the cli commands
- [ ] wire `openrep create` to `createAgent` and print the returned manifest
- [ ] wire `openrep attest` flags to `attest` and print the signed attestation
- [ ] wire `openrep ingest --file <path> --source <name>` to `ingest` and print the normalized result
- [ ] wire `openrep score <name>` to `getScore` (via resolve) and print composite plus breakdown
- [ ] wire `openrep resolve <name>` to `resolve` and print manifest plus score
- [ ] implement `openrep verify <name>` independently: verify the manifest signature, then re-hash and check every attestation signature against the public key, with no trust in the openrep server
- [ ] make `openrep verify` exit non-zero on a failed signature so it is usable as a ci gate
- [ ] implement cli key custody per the `## cli key custody policy` section in technical.md: native os credential store for interactive runs with `openrep create` auto-stashing the generated key, encrypted-file fallback under `~/.openrep/credentials.enc` with a passphrase-derived key (aes-256-gcm, pbkdf2/scrypt), and one-shot env-injected keys for headless/ci runs with no persistence on that path
- [ ] run every command end to end against the real sdk and storage and confirm the output is real data, not a placeholder

## phase 7, web app: sdk wiring and chat

- [ ] set up a server side boundary in the next.js app (api routes or server actions) so the sdk and its private keys never run in the browser
- [ ] add a server endpoint to create an agent via the sdk and return the public manifest
- [ ] add a server endpoint to list the stored agents with their current scores for the sidebar
- [ ] add a server endpoint to send a chat message: load the agent keypair, run the real model api call wrapped with `wrapAgent`, persist the attestation, and return the model reply
- [ ] implement the sidebar UI listing real agents from storage with their score badges and a working new agent action
- [ ] implement the chat panel that sends a user message to the chat endpoint and renders the model reply
- [ ] implement the score display so it calls `getScore` and reflects the real persisted data
- [ ] implement the comparison view rendering each agent's composite and per-source breakdown side by side from real scoring
- [ ] model multiple agents per user as separate rows, each with its own independent keypair, history, and score

## phase 8, demo readiness

- [ ] confirm the live chat to score update flow works end to end with a real model call: sending a message produces a real signed attestation and visibly moves the agent's score on screen
- [ ] confirm ingesting a sample external attestation visibly changes a score and appears under the right source in the breakdown
- [ ] confirm all multi agent views show the correct distinct scores for each agent
- [ ] confirm `openrep verify` validates an intact agent history and that no part of the demo path is a stub or a placeholder
- [ ] remove any leftover stub, "not implemented yet" throw, or hardcoded demo value from the code paths the demo touches
- [ ] run the full demo from a clean state: create an agent, chat, watch the score update, ingest a sample attestation, watch the breakdown update, verify the ledger

## deferred, written decisions

- activity events: `createAgent` does not emit an `ActivityEvent` in this pass. the activity feed is not built yet, and emitting `agent_created` now would be dead code. when the feed is built, wiring `agent_created` into the create path is part of that work, not a new decision.
- session key persistence: aes-256-gcm envelope encryption and the `SessionKeyStore` are not implemented yet. keys are memory-only today, which is fine for single request flows but must be scheduled before `createAgent` is wired into the multi-turn chat ui.

## not in scope

- no licensing or contributor docs
- no deployment or hosting setup unless it turns out the demo cannot run without it
