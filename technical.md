# openrep, technical notes

this is a reference document for anyone picking this codebase back up, including us. it explains how the pieces fit together and how the system is meant to work end to end. the code is currently stubbed, so where a section describes behavior that is not yet implemented that is called out explicitly. the "as designed" descriptions below are the contract the implementations should match.

## architecture overview

openrep is a pnpm monorepo with three packages.

- `packages/sdk`, published as `@openrep/sdk`. the core library. plain typescript, no framework, no react, no next. it owns the identity model, the attestation model, score calculation, ingestion, and resolution. everything that matters lives here so it can be reused by every surface without duplicating logic.
- `packages/cli`, published as `@openrep/cli`. a commander based command line tool. it depends on `@openrep/sdk` and exists for developers who want to script openrep into pipelines, ci checks, or their own agent tooling without a browser. every command is a thin wrapper around an sdk function.
- `apps/web`, named `web` in the workspace. a next.js app router application using typescript and tailwind. it also depends on `@openrep/sdk`. it is the human facing product: create agents, chat with them, watch reputation build live.

the dependency graph is a simple chain. the sdk depends on nothing local. the cli depends on the sdk. the web app depends on the sdk. nothing depends on the web app or the cli. that keeps the sdk the single source of truth for all reputation logic.

it is structured as a monorepo for two reasons. first, the sdk, cli, and web app all need to share the exact same types and logic, and a local workspace link means they compile against the same source rather than against a published copy that can drift. second, the sdk is small and pure, so keeping it as its own package means it can be published on its own later without dragging in react or next.

workspace links are handled by pnpm through the workspace protocol. both the cli and web app declare `"@openrep/sdk": "workspace:*"`, and pnpm creates a symlink from each of their `node_modules` to `packages/sdk`. the root `pnpm-workspace.yaml` lists `packages/*` and `apps/*` as the package globs. root scripts: `pnpm dev` runs the web app, `pnpm build` builds every workspace with `pnpm -r build`.

## identity model

an agent's identity is a keypair plus a human readable name. when a new agent is created, `createAgent` does three things: generate a keypair, generate a human readable name, and produce a signed manifest.

the keypair is ed25519. ed25519 is chosen because it is the de facto standard for this kind of thing, it is fast, the signatures are compact (64 bytes), and it is available across languages, which matters for a platform that is meant to be read by many ecosystems. the private key stays with the agent and is never transmitted. the public key is what gets published in the manifest and used by anyone verifying the agent's attestations.

the human readable name is generated from a word list, typically three words plus a known suffix, like `beautiful-pig-black.agent`. the name is not security, it is ergonomics. it gives people and logs something memorable to refer to instead of a raw hex public key. the cryptographic identity is the keypair.

the signed manifest is the portable identity card. field by field:

- `id: string`. a stable identifier for the agent. used as the foreign key across attestations, scores, and storage lookups.
- `name: string`. the human readable name described above, for example `beautiful-pig-black.agent`.
- `publicKey: string`. the agent's ed25519 public key, base encoded. this is what signatures are verified against.
- `createdAt: string`. an iso 8601 timestamp of when the agent was created.
- `signature: string`. the ed25519 signature over the rest of the manifest fields, produced with the private key.

the signature proves that whoever holds the private key generated and stands behind this manifest. verification is the inverse: take the public key, hash the manifest fields (excluding the signature itself), and check the ed25519 signature. if it verifies, the manifest came from the keypair that owns that public key. this is what lets a verifier trust an agent without trusting the openrep server, because verification needs only the public key and the payload, both of which travel with the agent.

## attestation model

an attestation is proof that an agent completed a specific piece of work. it is not a claim, it is a signed record of what actually happened. openrep's own attestations all use the same shape.

the `Attestation` type, field by field:

- `agentId: string`. the id of the agent this attestation is about. ties the attestation to a specific identity.
- `task: string`. a description of what the agent was asked to do. this is the prompt or task statement, kept as evidence of the work.
- `output: string`. what the agent actually produced. for a chat run this is the model's response text. for a tool run it can be the tool result, serialized.
- `source: string`. who is vouching for this attestation. values for openrep's own runs are things like `chat` or `cli`. for ingested external work this carries the external platform name, for example `github` or `stripe`. the source is what lets scores be broken down.
- `timestamp: string`. an iso 8601 timestamp of when the work happened.
- `signature: string`. the ed25519 signature over the attestation payload, produced with the agent's private key.

producing an attestation during a real run is the job of `wrapAgent`. `wrapAgent(agentId, agentFn)` wraps an agent's run function. the wrapper records what is asked and what comes back. specifically, it captures the task (the incoming prompt), the tool calls the model makes during the run, and the final output. from those it builds the attestation payload, calls `attest` to sign it, and returns the original run result to the caller so the behavior of the agent is unchanged.

`attest(agentId, task, output, source)` is the signing primitive. it assembles the attestation fields, hashes the canonical form of them, signs with the agent's private key, and returns a fully populated and signed `Attestation`. signing ties the attestation to the identity: anyone with the public key can verify the attestation was produced by the agent's keypair and that the payload was not tampered with.

for the claude/gpt case specifically, the flow is: the user sends a message, the run function sends it to the model api, the model returns a response and possibly tool calls, and `wrapAgent` turns the request text plus the response text (and the tool calls if any) into the attestation payload. the model's response is the `output`. the tool calls are recorded as part of the evidence chain and become part of the hash, so a later change to what the model actually did would invalidate the signature.

## ingestion model

ingestion is how openrep merges reputation that was created somewhere else. not every platform writes openrep format attestations, so `ingest` exists to normalize external records into the same schema.

external platforms hand over something like the `ExternalAttestation` type. its fields mirror the native one, with a `platform` field naming where it came from and an `agentName` instead of an openrep agent id, because the external platform addresses agents by their own name. `ingest` takes that external record, verifies it where possible, maps it into a native `Attestation`, and stores it under the local agent that matches the external name.

the `source` field is what carries platform awareness through the unified schema. every attestation, native or ingested, records where it came from. that single field is what makes the score breakdown by source possible, and it is the mechanism that keeps openrep platform agnostic: it does not care which chain or marketplace produced an attestation, it only records the origin and folds it into the same per-agent ledger.

the composite score is computed by `getScore`. it returns a `ReputationScore` with a single `composite` number and a `breakdown` array of `ScoreBreakdown` entries. each breakdown entry has a `source`, a `count` (how many attestations that source has contributed), and an `avgConfidence` (some per-source quality signal). the composite is a weighted aggregation across those sources. the exact weighting is an implementation detail that can be tuned, but the shape is fixed so the web app and cli can always render it the same way. openrep stays platform agnostic because the score is always presented as a composite plus a per-source breakdown, never as a single number locked to one chain's semantics.

`resolve(name)` ties the two models together: it looks up an agent by its human readable name and returns a `ResolvedAgent` containing both the `AgentManifest` and the `ReputationScore`. a caller that only knows a name gets everything needed to verify the identity and read the reputation.

## storage

this is a hackathon build, and the storage is deliberately honest about being local. the intent is a sqlite database (via better-sqlite3 or similar) backed by a single file, or failing that a local json store on disk. there is no server, no network service, and no distributed system. all persistence lives inside the sdk package and is exercised directly by the cli and web app.

the storage schema in sqlite terms is three tables.

- `agents`. columns: `id` (primary key), `name` (unique), `public_key`, `created_at`, and the raw `manifest` json so the signed manifest can be returned and verified later.
- `attestations`. columns: `id`, `agent_id` (foreign key to agents), `task`, `output`, `source`, `timestamp`, and `signature`.
- optionally a small ledger or index of which sources contributed, which is really just derivable from `attestations` grouped by `agent_id` and `source`, so scoring does not need a separate table.

the `agents.name` column is unique because `resolve` looks agents up by name. the `attestations.agent_id` foreign key is how all reputation funnels back to one identity. scores themselves are not stored, they are computed on demand from the attestation table by `getScore`, which keeps storage append only and avoids stale scores.

this design is fine for a demo, and it is a real weakness for production. there is no durability story across machines, no access control, and no multi tenancy. anyone who could read the file could read or forge the data, which matters because without a trusted service the only real protection is the signatures themselves. the storage is treated as honest but single user.

## the web app

the web app is a next.js app router application that imports `@openrep/sdk`. because the sdk is plain typescript with no server dependency at runtime, it can run on the server, and that is where the reputation state should live.

the intended setup keeps the sdk on the server side, behind next.js api routes or server actions. the flow is: the server imports the sdk, and the client browser components never hold the private keys. a user creates an agent through a server call that runs `createAgent` and returns the public manifest and a handle. the private key stays server side, tied to the session or the agent record. letting private keys reach the browser would defeat the whole signing model, so the boundary between client and server is also a trust boundary.

the chat flow, end to end: the user selects an agent in the sidebar, types a message in the chat panel, and hits send. the message goes to a server action or api route. the server loads that agent's keypair from storage, runs the model call (claude or gpt) with `wrapAgent`, which captures the task, the tool calls, and the output and signs an attestation. the server stores the attestation and returns the model's reply to the browser. the browser renders the reply. the score component on screen calls `getScore` for that agent again, and because a new attestation was just stored, the composite and the breakdown tick up. nobody in that loop manually bumps a number, the score update is a pure consequence of storing a new attestation.

multiple agents per user are modeled as multiple rows in the `agents` table. each has its own id, name, keypair, and attestation history, and therefore its own independently computed score. the app shows one score per agent, and the comparison view renders all of an agent's breakdowns side by side. the current `page.tsx` is an empty fragment, so none of this is built yet; this section is the design it should converge on.

## the cli

the cli maps one to one onto sdk functions. `openrep create` calls `createAgent`. `openrep attest` calls `attest` with the flags as arguments. `openrep ingest` reads the file and calls `ingest`. `openrep score` calls `getScore`. `openrep resolve` calls `resolve`. each command carries the relevant flags to keep it scriptable without a browser.

`openrep verify` is the outlier and the most important one for trust out of a pipeline. it does not call the score functions. instead it takes an agent, pulls the full attestation history, re-hashes each attestation's payload, and checks each signature against the agent's public key, all locally and with no need to trust the openrep server. the public key comes from the signed manifest, and the manifest itself is verified first. if every manifest signature and every attestation signature checks out, the attestation history is intact and the agent is who it claims to be. this is what makes verify useful for ci or third party audits: it needs nothing from openrep's infrastructure beyond the data on disk, and it produces an independent, cryptographic answer.

## known limitations

these are the honest simplifications, so nobody mistakes this for production grade infrastructure.

- storage is local and single user. sqlite or a json file on disk, no server, no durability across machines, no access control, no multi tenancy.
- external attestations are mocked as sample data for the demo. there are no live integrations pulling real attestations from other platforms or chains, so ingest is exercised against hand written sample input that looks like what a real platform would produce.
- there is no payment or staking layer. reputation here is purely attestation derived; there is no economic component, no token, and no way for reputation to carry monetary weight.
- the web app has no authentication. it is a single user demo. there is no notion of accounts or ownership beyond the local agent rows.
- the sdk, cli, and web app are currently stubs. the types and signatures are real and compile, but every function throws "not implemented yet". the descriptions above are the agreed design, the implementation is the work still to do.
- score weighting is a placeholder policy, not a researched formula. whichever weighting is chosen for the demo should be treated as a starting point, not a standard.
