# openrep, build checklist

this is the working task list for taking the workspace from its current stubbed state to a fully working demo. tasks build the real thing: real keypair generation, real signing, real model api calls, real storage, real score calculation. the only data that is legitimately mocked is external cross platform attestations, which are sample input files because there are no live external platforms to pull from. those sample files are labeled as sample data, they are not a shortcut on our own logic.

## phase 1, sdk core: identity

- [ ] add a keypair dependency to `packages/sdk` (ed25519 via `@noble/curves` or node `crypto`)
- [ ] implement `createKeypair()` that generates a real ed25519 keypair and returns encoded public and private keys
- [ ] implement human readable name generation: a word list plus a suffix, e.g. `beautiful-pig-black.agent`, with randomness when no name is given
- [ ] implement manifest signing: hash the manifest fields and sign with the ed25519 private key
- [ ] implement `createAgent(name?)` composing keypair generation, name generation, and manifest signing to return a signed `AgentManifest`
- [ ] add a `verifyManifest(manifest)` helper that re-hashes and checks the manifest signature against its public key
- [ ] write a unit test that creates an agent and verifies the returned manifest signature

## phase 2, sdk core: storage

- [ ] add a sqlite dependency to `packages/sdk` (better-sqlite3) as the local store
- [ ] create the storage module that opens a sqlite database file in a sensible default location
- [ ] create the `agents` table (id, unique name, public_key, created_at, manifest json)
- [ ] create the `attestations` table (id, agent_id foreign key, task, output, source, timestamp, signature)
- [ ] implement `saveAgent(manifest)` to insert a signed manifest
- [ ] implement `getAgentById(id)` and `getAgentByName(name)` reads
- [ ] implement `saveAttestation(attestation)` to append a signed attestation to the ledger
- [ ] implement `listAttestations(agentId)` to return an agent's full history for scoring and verify
- [ ] implement `getAgentPublicKey(agentId)` so signing and verify can look up the key
- [ ] make the storage path the single shared access point the sdk, cli, and web app all use

## phase 3, sdk core: attestation and capture

- [ ] implement `attest(agentId, task, output, source)` that builds the attestation payload, signs it with the agent's private key, stores it, and returns the signed `Attestation`
- [ ] implement canonical payload hashing so attestation and verify hash the same bytes
- [ ] implement `wrapAgent(agentId, agentFn)` so it records the task passed in, works when `agentFn` makes real model api calls, and captures the model's response as `output`
- [ ] capture tool calls made inside the wrapped run and fold them into the attestation evidence so they are covered by the signature
- [ ] make `wrapAgent` side effect on storage per call, producing one real signed attestation per run
- [ ] write a unit test that runs a wrapped function and asserts a signed, persisted attestation with the correct output

## phase 4, sdk core: scoring and resolution

- [ ] implement `getScore(agentId)` from the real attestation history, not from any hardcoded value
- [ ] compute per-source breakdown with `count` and `avgConfidence` from the real attestations
- [ ] combine the per-source values into a single composite score (define and implement the weighting policy)
- [ ] implement `resolve(name)` that looks up the manifest by name and returns the live computed `ReputationScore`
- [ ] write a unit test that ingests a few real attestations and asserts the composite and breakdown reflect exactly those attestations

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

## not in scope

- no licensing or contributor docs
- no deployment or hosting setup unless it turns out the demo cannot run without it
