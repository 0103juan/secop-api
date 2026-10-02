# secop-api

A small HTTP API over Colombia's public procurement data: the six million **SECOP II electronic contracts** published on [datos.gov.co](https://www.datos.gov.co/d/jbjy-vk9h). It answers one question well: how much did a state entity contract in a year, with whom, how, and through which contracts.

It is the backend of [secop-dashboard](../secop-dashboard) (Angular) and [secop-mobile](../secop-mobile) (Flutter). Node.js 24 and TypeScript, with **no runtime dependencies**: `node:http`, the built-in `fetch`, the built-in test runner, and Node's native TypeScript support, so there is no build step.

Live at <https://secop-api-i89q.onrender.com> (free plan: the first request after a pause takes about a minute).

```
GET /                                       what is here, with links to try
GET /entities?q=medellin                    search the entity directory (in memory)
GET /entities/890905211                     the entity and its contracts per year
GET /entities/890905211/overview?year=2024  totals, top suppliers, modalities, months
GET /entities/890905211/contracts?year=2024&page=1
GET /entities/890905211/contracts?year=2024&modality=Contrataci%C3%B3n%20directa    only one modality
GET /health
```

## Why there is an API at all

The open data portal has its own query API, and a browser could call it directly. This layer exists for four reasons:

- **Searching entities upstream takes about 90 seconds.** A name search is a `LIKE` over six million rows. The directory of 5,800 entities is built once by `npm run refresh-entities` (one grouped query, about 90 seconds), committed as `data/entities.json`, and searched in memory, ignoring case and accents, in about 3 ms.
- **Personal data stays behind.** The dataset has 95 columns, including bank accounts, addresses and ID numbers. Each query selects a fixed list of columns. Suppliers are grouped by document number, because their names are typed inconsistently, but the number itself (often a person's cédula) is never selected into a response. A test asserts it.
- **Clients cannot write queries.** A NIT must be 5 to 12 digits, a year an integer in range, a page an integer up to 500. Only those numbers are placed in SoQL; nothing a client types is concatenated into a query. The one text filter, `modality`, works by lookup: the client's text has to equal one of the modalities the dataset itself returned for that entity and year, and the query is built from the dataset's value, with quotes escaped. Anything else is a 400 that never reaches the portal.
- **The portal is slow and rate-limited.** Responses are cached in memory for an hour, concurrent identical requests share one upstream call, failures are never cached, and each client gets 60 requests a minute.

## What the data taught me

- **One entity, many spellings.** The directory query returns 6,586 name records for 5,800 NITs, and a city's departments often publish under the city's NIT. The commonest spelling becomes the display name; every other one stays searchable.
- **Values are typed by hand.** One 2019 contract of the city of Medellín is recorded at about 7.7 × 10²⁰ pesos. The overview therefore returns `largest` next to `total`, so a client can tell when one contract explains the whole year. Both front ends turn that into a visible warning.
- **Drafts and cancelled contracts are not spending**, so every query excludes them.
- **Some signing dates are mistyped** (years far in the past or future); the year list keeps 2015 to the current year.

## Run it

```bash
npm install          # two dev dependencies: typescript and @types/node
npm start            # http://localhost:3000
npm test             # 11 tests, no network
LIVE=1 npm test      # adds one test that sends every query to the real datos.gov.co
npm run typecheck
```

Environment variables: `PORT` (default 3000), `ALLOWED_ORIGIN` for CORS (default `*`: the data is public and read-only), `SOCRATA_APP_TOKEN` (optional, raises the portal's anonymous rate limit).

Measured on 1 October 2026 against the live portal: a cold overview (four upstream queries in parallel) took 1.3 s, a contracts page 0.7 s, and both about 1 ms once cached. The portal's speed varies from one hour to the next.

## Continuous deployment

Every push to `main` runs the type check and the tests in GitHub Actions (`.github/workflows/ci.yml`).

`render.yaml` describes a free [Render](https://render.com) web service: connect the repository once (New, Blueprint) and Render redeploys on every push. There is no build step, because Node runs the TypeScript directly. The free plan sleeps after 15 idle minutes, so the first request after a pause takes about a minute.

## Limits

- Only SECOP II. Contracts published in SECOP I or the state's online store are not here, so totals are a floor, not all of an entity's contracting.
- Cache and rate limiter live in the process: one instance only. Behind a proxy the limiter sees the proxy's address, so limit there instead.
- The entity directory is a snapshot; a new entity appears after `npm run refresh-entities`.
- The largest-contract signal flags suspicious totals; it does not correct them.
- Supplier names in the contract list include natural persons. That is public information under Colombian transparency law, and it is shown exactly as the source publishes it.

## Layout

```
src/soql.ts        every query the API can send, and the parameter validation
src/entities.ts    the entity directory: merge spellings, search in memory
src/app.ts         routing, cache, rate limit, error mapping
src/server.ts      entry point
scripts/refresh-entities.ts
test/api.test.ts
```
