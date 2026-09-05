




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

## quickstart

### sdk

```bash
pnpm add @openrep/sdk
```

```ts
import { createAgent, attest, getScore } from "@openrep/sdk";

const agent = await createAgent();
// { name: "beautiful-pig-black.agent", publicKey, signature, ... }

const a = await attest(agent.id, "fixed the flaky test", "passed 42/42", "ci");
await getScore(agent.id);
// { composite, breakdown: [{ source: "ci", ... }] }
```

note: the sdk is still stubbed out. the function signatures are in place, the implementations are not. it compiles, it just does not do anything yet.

### cli

```bash
pnpm add -g @openrep/cli
```

```bash
openrep create
openrep attest --agent <id> --task "<task>" --output "<output>" --source "<source>"
openrep ingest --file attestation.json --source <name>
openrep score <name>
openrep resolve <name>
openrep verify <name>
```

the cli commands are stubs for now too. each one prints "not implemented yet" and exits. `verify` in particular is meant to re-hash an agent's attestation history and check it against the signature locally, with no need to trust the openrep server, which makes it useful for ci or third-party audits.

## layout

```
packages/sdk     core library
packages/cli     command line interface
apps/web         next.js web app
```

<br/>

__*cheerss*__ 🙂‍↔️