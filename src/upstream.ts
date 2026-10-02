// The one place that talks to datos.gov.co: runs a query, caches the answer and names the failures.

import { DATASET, type Soql } from "./soql.ts";

const CACHE_TTL_MS = 60 * 60 * 1000; // contracts are published daily; an hour-old total is fine
const CACHE_MAX = 500;
const TIMEOUT_MS = 60_000;

export type Row = Record<string, unknown>;
export type Upstream = (soql: Soql) => Promise<Row[]>;

/** The portal failed (502) or did not answer in time (504). The message is safe to show a client. */
export class UpstreamError extends Error {
  readonly status: 502 | 504;
  constructor(status: 502 | 504, message: string) {
    super(message);
    this.status = status;
  }
}

type Dependencies = { fetch: typeof fetch; now: () => number; appToken?: string };

/** Runs each query once: concurrent and repeated requests share the same promise until it expires. */
export function createUpstream({ fetch, now, appToken }: Dependencies): Upstream {
  const cache = new Map<string, { expires: number; rows: Promise<Row[]> }>();

  return (soql) => {
    const key = JSON.stringify(soql);
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.rows;
    const rows = (async () => {
      const response = await fetch(`${DATASET}?${new URLSearchParams(soql)}`, {
        headers: { "User-Agent": "secop-api", ...(appToken ? { "X-App-Token": appToken } : {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch((error: Error) => {
        throw new UpstreamError(504, `datos.gov.co did not answer (${error.name})`);
      });
      if (!response.ok) throw new UpstreamError(502, `datos.gov.co answered HTTP ${response.status}`);
      return (await response.json()) as Row[];
    })();
    cache.delete(key);
    cache.set(key, { expires: now() + CACHE_TTL_MS, rows });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!); // oldest entry
    rows.catch(() => cache.delete(key)); // never cache a failure
    return rows;
  };
}
