# apps/marketplace

placeholder for a small task marketplace app that is planned but not built yet.

## what this will be

a small, genuinely working task marketplace:

- post a task
- claim a task
- complete a task
- rate a task

with real persistence and a real api. it is the planned real-world source for openrep's ingestion (see technical.md, "ingestion model"), replacing the earlier plan of a static sample json file as the demo source.

## how it will be built

the ui/frontend will be built by hand, by the person building this project, without ai assistance, on their own timeline — that part is deliberately not built by an ai coding agent. the rest of the app (backend, persistence, api) may be built with ai assistance. this is planned, not deferred indefinitely — it is just not built yet. no application code, scaffolding, package.json, or dependencies exist here yet, by design.

## api contract (target, once it exists)

- `GET /api/agents/:agentId/completed-tasks` — returns the agent's real completed and rated tasks.

on the openrep side, a `MarketplaceAdapter` will call this endpoint over real http and normalize the response into `NormalizedExternalAttestation`. the marketplace does no cryptographic signing, so anything ingested from it is honestly unverified (`externalVerification.checked` is `false`); there is no `validate()` on the adapter.