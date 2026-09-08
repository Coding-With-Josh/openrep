# openrep daily summary — 2026-09-08 (evening session)

## Objective
Stand up the live server side of the openrep web demo per design.md: B.2 web storage boot + guest session cookie → C.1–C.5 anonymous guest endpoints (session, server-side agent custody + create, owner list, chat runs with persisted transcripts + attestations via Groq, public score/verify reads). Backend plan Units 0–3 done and live-verified, then the user re-scoped: real account auth first (Google + credentials/scrypt, no GitHub) — implemented and curl-verified. UI frontend wiring is the next push (planned, not started).

## Outcome
**Backend is complete and live-verified end to end.** All C.1–C.5 routes work against the production build on `:3177` with real Groq turns; the full adversarial matrix passes; all gates green.

## What shipped this session
- **Unit 3 routes (all four, in `apps/web/src/app/api/`):**
  - `api/session/route.ts` — POST mint/refresh of signed guest cookie (HMAC-SHA256 over `userId.createdAt`, stateless, httpOnly+lax+secure, 30d).
  - `api/agents/route.ts` — POST create (name validated exactly like SDK, envelope-encrypted key custodied under `session_keys`, private key dropped, public manifest only) + GET owned list (`{ manifest, score, sessionStatus }`, no sliding on list read).
  - `api/agents/[id]/chat/route.ts` — POST: cookie gate → rate limit → session-key authz (403) → message ≤ 4000 → createChatSession get-or-create → score before → `wrapAgent` with Groq config → persist user+assistant messages (only on success) → score delta + attestation. GET: transcript for owned agent.
  - `api/agents/[id]/score/route.ts` — GET: manifest + manifestVerdict + score + paginated attestations with per-row `verifyAttestation` verdicts + verifiedCount/totalCount (public read, cookie-gated).
- **Server scaffolding (from earlier units, all in place):** config, coded error map, session token utils, request-context storage (local sqlite / hosted Turso), fixed-window rate limiter, `requireSession`/`readJsonBody`/`clientIp`.
- **SDK (from earlier units):** chat history tables + 5 StorageAdapter methods, ownership listing, +12 tests.

## Three bugs found and fixed live
1. **Cookie URL-encoding:** Next serializes cookie values with `encodeURIComponent` (`%3A` in timestamps) → round-tripped cookies failed HMAC. Fixed `readCookie` to `decodeURIComponent` (try/catch → undefined). Verified idempotent session round-trip.
2. **`options.source: "chat"` invalid:** SDK `attest()` only accepts `"native"` (external sources belong to `ingest()` with registered adapters). Removed the option; web chat turns are first-party native runs. Also moved user-message persistence to *after* a successful run so failed turns don't leave orphaned transcript entries.
3. **Groq model gating (the 404 mystery):** the web server (dotenv-parsed key) got 404 with `llama-3.3-70b-versatile` because it is **Enterprise-tier** at Groq → `model_not_found` for dev keys. Shell probes looked like "invalid key" only because the `.env.local` line contained a key **plus prose** (spaces/commas/semicolons) and my cut kept the garbage. Fixed env line to bare key; switched `CHAT_CONFIG` model to **`openai/gpt-oss-20b`** (verified 200 with the key; `llama-3.1-8b-instant` and `llama-4-scout` also gated for this org).

## Live verification matrix (production build, `pnpm exec next start -p 3177`)
| Check | Result |
|---|---|
| C.1 session mint + idempotent re-POST | 200, same userId, Secure cookie |
| No cookie on any route | 401 MISSING_SESSION |
| C.2 create (named / auto) | 200 public manifest only, no key material |
| C.2 duplicate name / invalid name | 409 DUPLICATE_NAME / 400 INVALID_INPUT |
| C.3 owned list | both agents, score 0→2, sessionStatus active |
| C.4 chat POST (real Groq) | scoreDelta 1 per turn, native attestation signed by agent key, persisted user+assistant |
| C.4 GET transcript | 5 messages, stored roles mapped user/assistant → user/agent |
| C.5 score GET | manifestVerdict valid, 2/2 attestations verified, breakdown `{native, value 2, count 2}` |
| C.5 unknown agent | 404 AGENT_NOT_FOUND |
| Cross-tenant chat / transcript / list | 403 MISSING_SESSION / 403 / `[]` (no leak) |
| Tampered + garbage cookie | 401 on protected routes; session endpoint re-mints (guest-first, by design) |
| Empty / 4001-char / non-JSON body | 400, 400 INPUT_TOO_LARGE, 400 |
| GET on POST-only session route | 405 |

## Gates
- `pnpm -r typecheck`: sdk + cli green.
- `pnpm --filter sdk test`: **316 passed | 9 skipped** (unchanged from Unit 1, nothing regressed).
- `pnpm --filter web build`: green (single cosmetic Google Sans Flex warning).

## Environment notes
- `.env.local` now has a clean single-line `OPENREP_GROQ_API_KEY=gsk_<52-char>` (was key+prose; quotes stripped). All 7 vars present. `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` optional (Google provider only registers when both present).
- Storage backend is **hosted Turso** (`TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` set); agents created during the curl journey persist in the hosted DB.
- All servers currently down (user requested). Restart: `nohup pnpm --filter web start &` (port 3000) after `pnpm --filter web build`.

## Auth phase (DONE, live-verified)
- User directive: auth first, Google + credentials/scrypt, **no GitHub**.
- SDK Unit A: `DUPLICATE_EMAIL`/`DUPLICATE_ACCOUNT`/`USER_NOT_FOUND` error codes; `UserRecord`/`AccountLink` types; `users`+`accounts` tables (email unique, provider+providerAccountId unique, FK user_id) in both adapters; 6 new StorageAdapter methods; `mergeOwner` transactional per engine (sqlite BEGIN/COMMIT/ROLLBACK, libsql `batch(...,"write")`), idempotent, self-merge no-op. 18 new tests (316 → 334 passed).
- Web Unit B: `server/password.ts` (scrypt N=16384 r=8 p=1, envelope `scrypt:N:r:p:salt:hash`, param caps so stored hashes cannot force expensive ops, timingSafeEqual); `server/auth.ts` (NextAuth v5, derived AUTH_SECRET = HMAC(masterKey), conditional Google, Credentials with self-service auto-create, generic deny everywhere, dummy-scrypt timing equalization on oauth-only paths, guest merge inside jwt callback reading cookie via `cookies()`); `api/auth/[...nextauth]/route.ts`; async account-first `requireSession` (auth() wins, guest cookie fallback) at all 5 route call sites; config additions fail-closed both-or-neither; 3 new status codes.
- Web Unit C: SessionProvider wrapper in layout, real `signIn`/`signOut` in `sign-in-modal.tsx` (Google `redirect:false`, credentials with min-8 client hint, generic "invalid email or password"), `agents/page.tsx` reads `useSession()`.
- Curl-verified: guest baseline (2 agents) → credentials sign-in with guest cookie → account session minted, merge moved both agents + chat attestations + session keys to the account (old guest jar now 0), fresh no-guest sign-in idempotent, wrong + short passwords denied with no session, email normalization, auto-create new email, guest-first fallback intact, transcript 200 as account / 403 as old guest.

## Next push (planned, not started)
Remaining auth residuals: Google OAuth live test needs real `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (provider skipped when absent; credentials flow fully verified without it). Then UI wiring: wire the five mock UI pages to the routes (session bootstrap on app mount, create form → POST agents, real list → GET agents, detail/chat → chat GET/POST + score GET, score page → verify badges). Deploy mechanics unchanged: monorepo root on Vercel, `workspace:*` sdk, `pnpm -r build` topology.