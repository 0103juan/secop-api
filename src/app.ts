// The HTTP surface: routing, validation, caching, rate limiting and error mapping.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Directory } from "./entities.ts";
import { BadRequest, DATASET, FIRST_YEAR, PAGE_SIZE, parseNit, parsePage, parseYear, queries, type Soql } from "./soql.ts";

const CACHE_TTL_MS = 60 * 60 * 1000; // contracts are published daily; an hour-old total is fine
const CACHE_MAX = 500;
const UPSTREAM_TIMEOUT_MS = 60_000;
const RATE_LIMIT = 60; // requests per client per minute
const RATE_WINDOW_MS = 60_000;
const SECOP_URL = /^https:\/\/([a-z0-9-]+\.)*secop\.gov\.co\//i;

type Row = Record<string, unknown>;

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

export function createApp(options: Options) {
  const { directory, allowedOrigin = "*", appToken } = options;
  const fetchUpstream = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { expires: number; rows: Promise<Row[]> }>();
  let hits = new Map<string, number>();
  let windowStart = now();

  /** Run a query upstream, once: concurrent and repeated requests share the same promise. */
  function upstream(soql: Soql): Promise<Row[]> {
    const key = JSON.stringify(soql);
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.rows;
    const rows = (async () => {
      const response = await fetchUpstream(`${DATASET}?${new URLSearchParams(soql)}`, {
        headers: { "User-Agent": "secop-api", ...(appToken ? { "X-App-Token": appToken } : {}) },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      }).catch((error: Error) => {
        throw new HttpError(504, `datos.gov.co did not answer (${error.name})`);
      });
      if (!response.ok) throw new HttpError(502, `datos.gov.co answered HTTP ${response.status}`);
      return (await response.json()) as Row[];
    })();
    cache.delete(key);
    cache.set(key, { expires: now() + CACHE_TTL_MS, rows });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!); // oldest entry
    rows.catch(() => cache.delete(key)); // never cache a failure
    return rows;
  }

  function allow(client: string): boolean {
    if (now() - windowStart >= RATE_WINDOW_MS) {
      hits = new Map();
      windowStart = now();
    }
    const count = (hits.get(client) ?? 0) + 1;
    hits.set(client, count);
    return count <= RATE_LIMIT;
  }

  function entity(nit: number) {
    const found = directory.get(nit);
    if (!found) throw new HttpError(404, "No entity with that NIT has contracts in SECOP II");
    return found;
  }

  const routes: [RegExp, (match: RegExpMatchArray, params: URLSearchParams) => Promise<unknown> | unknown][] = [
    [/^\/health$/, () => ({ status: "ok", entities: directory.size })],

    [/^\/entities$/, (_, params) => ({ items: directory.search(params.get("q") ?? "") })],

    [/^\/entities\/([^/]+)$/, async ([, rawNit]) => {
      const found = entity(parseNit(rawNit));
      const thisYear = new Date(now()).getFullYear();
      const years = (await upstream(queries.years(found.nit)))
        .map((row) => ({ year: Number(row.anio), contracts: Number(row.contratos), total: Number(row.total ?? 0) }))
        .filter(({ year }) => year >= FIRST_YEAR && year <= thisYear); // drops mistyped signing dates
      return { ...found, years };
    }],

    [/^\/entities\/([^/]+)\/overview$/, async ([, rawNit], params) => {
      const { nit } = entity(parseNit(rawNit));
      const year = parseYear(params.get("year"), new Date(now()));
      const [totals, suppliers, modalities, months] = await Promise.all([
        upstream(queries.totals(nit, year)), upstream(queries.topSuppliers(nit, year)),
        upstream(queries.byModality(nit, year)), upstream(queries.byMonth(nit, year))]);
      const byMonth = new Map(months.map((row) => [Number(row.mes), row]));
      return {
        nit, year,
        contracts: Number(totals[0]?.contratos ?? 0),
        total: Number(totals[0]?.total ?? 0),
        // The values are typed by hand and some are off by orders of magnitude, so a client
        // needs the largest single contract to judge how much of the total to believe.
        largest: Number(totals[0]?.mayor ?? 0),
        suppliers: Number(totals[0]?.proveedores ?? 0),
        topSuppliers: suppliers.map((row) => ({
          name: String(row.proveedor ?? "").trim(), contracts: Number(row.contratos), total: Number(row.total ?? 0) })),
        byModality: modalities.map((row) => ({
          modality: String(row.modalidad ?? "Sin modalidad"), contracts: Number(row.contratos), total: Number(row.total ?? 0) })),
        byMonth: Array.from({ length: 12 }, (_, i) => ({
          month: i + 1, contracts: Number(byMonth.get(i + 1)?.contratos ?? 0), total: Number(byMonth.get(i + 1)?.total ?? 0) })),
      };
    }],

    [/^\/entities\/([^/]+)\/contracts$/, async ([, rawNit], params) => {
      const { nit } = entity(parseNit(rawNit));
      const year = parseYear(params.get("year"), new Date(now()));
      const page = parsePage(params.get("page"));
      const rows = await upstream(queries.contracts(nit, year, page));
      return {
        nit, year, page, pageSize: PAGE_SIZE, hasMore: rows.length > PAGE_SIZE,
        items: rows.slice(0, PAGE_SIZE).map((row) => {
          const url = (row.urlproceso as { url?: string } | undefined)?.url ?? "";
          return {
            id: String(row.id_contrato ?? ""),
            reference: String(row.referencia_del_contrato ?? ""),
            object: String(row.objeto_del_contrato ?? ""),
            supplier: String(row.proveedor_adjudicado ?? ""),
            value: Number(row.valor_del_contrato ?? 0),
            signedOn: String(row.fecha_de_firma ?? "").slice(0, 10),
            status: String(row.estado_contrato ?? ""),
            modality: String(row.modalidad_de_contratacion ?? ""),
            type: String(row.tipo_de_contrato ?? ""),
            url: SECOP_URL.test(url) ? url : null, // only ever link back to SECOP itself
          };
        }),
      };
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
      if (error instanceof HttpError) return send(error.status, { error: error.message });
      console.error(error);
      send(500, { error: "Internal error" }); // details stay in the log
    }
  };
}
