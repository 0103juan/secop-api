// The HTTP surface: routing, rate limiting and error mapping. What is asked upstream lives in
// soql.ts, how it is fetched and cached in upstream.ts, and what a client receives in views.ts.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Directory } from "./entities.ts";
import { BadRequest, parseNit, parsePage, parseYear, queries } from "./soql.ts";
import { createUpstream, UpstreamError } from "./upstream.ts";
import { NO_MODALITY, toContractPage, toOverview, toYears } from "./views.ts";

const RATE_LIMIT = 60; // requests per client per minute
const RATE_WINDOW_MS = 60_000;

export type Options = {
  directory: Directory;
  fetch?: typeof fetch;
  now?: () => number;
  allowedOrigin?: string; // CORS; the data is public and read-only, so the default is any origin
  appToken?: string; // optional Socrata token, raises the anonymous rate limit
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A fixed window per client: simple, and enough to keep one visitor from spending the portal's quota. */
function createRateLimiter(now: () => number) {
  let hits = new Map<string, number>();
  let windowStart = now();
  return (client: string): boolean => {
    if (now() - windowStart >= RATE_WINDOW_MS) {
      hits = new Map();
      windowStart = now();
    }
    const count = (hits.get(client) ?? 0) + 1;
    hits.set(client, count);
    return count <= RATE_LIMIT;
  };
}

export function createApp(options: Options) {
  const { directory, allowedOrigin = "*" } = options;
  const now = options.now ?? Date.now;
  const upstream = createUpstream({ fetch: options.fetch ?? fetch, now, appToken: options.appToken });
  const allow = createRateLimiter(now);

  function entity(nit: number) {
    const found = directory.get(nit);
    if (!found) throw new HttpError(404, "No entity with that NIT has contracts in SECOP II");
    return found;
  }

  const routes: [RegExp, (match: RegExpMatchArray, params: URLSearchParams) => Promise<unknown> | unknown][] = [
    // Someone will open the bare address in a browser; tell them what is here.
    [/^\/$/, () => ({
      name: "secop-api",
      about: "Colombian public contracts (SECOP II, datos.gov.co) per state entity",
      code: "https://github.com/0103juan/secop-api",
      try: ["/entities?q=medellin", "/entities/890905211", "/entities/890905211/overview?year=2024",
            "/entities/890905211/contracts?year=2024&page=1",
            "/entities/890905211/contracts?year=2024&modality=Licitaci%C3%B3n%20p%C3%BAblica", "/health"],
    })],

    [/^\/health$/, () => ({ status: "ok", entities: directory.size })],

    [/^\/entities$/, (_, params) => ({ items: directory.search(params.get("q") ?? "") })],

    [/^\/entities\/([^/]+)$/, async ([, rawNit]) => {
      const found = entity(parseNit(rawNit));
      return { ...found, years: toYears(await upstream(queries.years(found.nit)), new Date(now()).getFullYear()) };
    }],

    [/^\/entities\/([^/]+)\/overview$/, async ([, rawNit], params) => {
      const { nit } = entity(parseNit(rawNit));
      const year = parseYear(params.get("year"), new Date(now()));
      const [totals, suppliers, modalities, months] = await Promise.all([
        upstream(queries.totals(nit, year)), upstream(queries.topSuppliers(nit, year)),
        upstream(queries.byModality(nit, year)), upstream(queries.byMonth(nit, year))]);
      return toOverview(nit, year, { totals, suppliers, modalities, months });
    }],

    [/^\/entities\/([^/]+)\/contracts$/, async ([, rawNit], params) => {
      const { nit } = entity(parseNit(rawNit));
      const year = parseYear(params.get("year"), new Date(now()));
      const page = parsePage(params.get("page"));
      // The client's text only picks one of the modalities the dataset returned for this entity
      // and year (the same cached query the overview uses); the query is built from that value.
      const wanted = params.get("modality");
      let modality: string | null | undefined;
      if (wanted !== null) {
        modality = (await upstream(queries.byModality(nit, year)))
          .map((row) => (row.modalidad ?? null) as string | null)
          .find((known) => (known ?? NO_MODALITY) === wanted);
        if (modality === undefined) throw new BadRequest("modality must be one of byModality in this entity's overview for that year");
      }
      return { nit, year, page, modality: wanted, ...toContractPage(await upstream(queries.contracts(nit, year, page, modality))) };
    }],
  ];

  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": allowedOrigin,
        "X-Content-Type-Options": "nosniff",
        ...headers,
      });
      response.end(JSON.stringify(body));
    };
    try {
      if (request.method === "OPTIONS") return send(204, null, { "Access-Control-Allow-Methods": "GET" });
      if (request.method !== "GET") throw new HttpError(405, "Only GET is supported");
      // ponytail: one counter per socket address. Behind a proxy that is the proxy's address;
      // read the forwarded header your platform sets, or rate-limit at the proxy.
      if (!allow(request.socket.remoteAddress ?? "unknown")) throw new HttpError(429, "Too many requests; try again in a minute");
      const url = new URL(request.url ?? "/", "http://localhost");
      for (const [pattern, route] of routes) {
        const match = url.pathname.match(pattern);
        if (match) return send(200, await route(match, url.searchParams), { "Cache-Control": "public, max-age=300" });
      }
      throw new HttpError(404, "No such route");
    } catch (error) {
      if (error instanceof BadRequest) return send(400, { error: error.message });
      if (error instanceof HttpError || error instanceof UpstreamError) return send(error.status, { error: error.message });
      console.error(error);
      send(500, { error: "Internal error" }); // details stay in the log
    }
  };
}
