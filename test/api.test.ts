import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp, type Options } from "../src/app.ts";
import { Directory, mergeDirectory } from "../src/entities.ts";
import { BadRequest, DATASET, parseNit, parsePage, parseYear, queries } from "../src/soql.ts";

const NIT = 890905211;
const directory = new Directory(mergeDirectory([
  { nit_entidad: String(NIT), nombre_entidad: "MUNICIPIO DE MEDELLIN", departamento: "Antioquia", orden: "Territorial", contratos: "40" },
  { nit_entidad: String(NIT), nombre_entidad: "DISTRITO DE MEDELLÍN", departamento: "Antioquia", orden: "Territorial", contratos: "60" },
  { nit_entidad: "800194096", nombre_entidad: "INSTITUTO DE DEPORTES Y RECREACION DE MEDELLIN", departamento: "Antioquia", orden: "Territorial", contratos: "500" },
  { nit_entidad: "899999061", nombre_entidad: "BOGOTÁ DISTRITO CAPITAL", departamento: "Bogotá", orden: "Territorial", contratos: "900" },
  { nit_entidad: "not-a-number", nombre_entidad: "BROKEN ROW", contratos: "1" },
]));

/** Start the API on a free port with a fake datos.gov.co that answers by the shape of the query. */
async function start(t: { after: (fn: () => void) => void }, overrides: Partial<Options> = {}) {
  const sent: URLSearchParams[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.equal(url.origin + url.pathname, DATASET);
    sent.push(url.searchParams);
    const select = url.searchParams.get("$select")!;
    const rows = select.startsWith("date_extract_y") ? [
        { anio: "1900", contratos: "1", total: "5" }, { anio: "2023", contratos: "10", total: "1000.5" },
        { anio: "2024", contratos: "12", total: "3000" }]
      : select.includes("count(distinct") ? [{ contratos: "12", total: "3000", mayor: "2500", proveedores: "7" }]
      : select.includes("max(proveedor_adjudicado)") ? [{ proveedor: " ACME SAS ", contratos: "3", total: "2600" }]
      : select.includes("as modalidad") ? [{ modalidad: "Contratación directa", contratos: "12", total: "3000" }]
      : select.includes("as mes") ? [{ mes: "3", contratos: "12", total: "3000" }]
      : Array.from({ length: 21 }, (_, i) => ({
          id_contrato: `CO1.PCCNTR.${i}`, objeto_del_contrato: "Obra", proveedor_adjudicado: "ACME SAS",
          valor_del_contrato: "100", fecha_de_firma: "2024-03-05T00:00:00.000", estado_contrato: "En ejecución",
          urlproceso: { url: i === 0 ? "https://evil.example/phish" : "https://community.secop.gov.co/Public/x?id=" + i },
        }));
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as typeof fetch;
  const server = createServer(createApp({ directory, fetch: fakeFetch, now: () => Date.UTC(2026, 9, 1), ...overrides }));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => {
    const response = await fetch(base + path);
    return { status: response.status, body: await response.json() as any, headers: response.headers };
  };
  return { get, sent };
}

test("the directory merges spellings of one entity and searches without case or accents", () => {
  assert.equal(directory.size, 3);
  assert.deepEqual(directory.get(NIT), {
    nit: NIT, name: "DISTRITO DE MEDELLÍN", department: "Antioquia", level: "Territorial", contracts: 100 });
  assert.deepEqual(directory.search("medellin").map((e) => e.nit), [800194096, NIT]); // biggest first
  assert.deepEqual(directory.search("  Distrito   MEDELLÍN ").map((e) => e.nit), [NIT]);
  assert.deepEqual(directory.search("municipio medellin"), [directory.get(NIT)]); // found by its other spelling
  assert.deepEqual(directory.search("bogota").map((e) => e.name), ["BOGOTÁ DISTRITO CAPITAL"]);
  assert.deepEqual(directory.search("me"), []); // too short to be a search
});

test("parameters are validated before any query is built", () => {
  assert.equal(parseNit("890905211"), NIT);
  for (const bad of ["", "12", "89090521a", "1 OR 1=1", "890905211'--", "1234567890123"]) {
    assert.throws(() => parseNit(bad), BadRequest, bad);
  }
  const now = new Date(Date.UTC(2026, 9, 1));
  assert.equal(parseYear("2024", now), 2024);
  for (const bad of [null, "", "2014", "2027", "2024.5", "2024 OR 1=1"]) assert.throws(() => parseYear(bad, now), BadRequest);
  assert.equal(parsePage(null), 1);
  for (const bad of ["0", "-1", "501", "1.5", "x"]) assert.throws(() => parsePage(bad), BadRequest);
});

test("queries exclude drafts and cancelled contracts and never select a supplier's document number", () => {
  for (const soql of [queries.years(NIT), queries.totals(NIT, 2024), queries.topSuppliers(NIT, 2024),
                      queries.byModality(NIT, 2024), queries.byMonth(NIT, 2024), queries.contracts(NIT, 2024, 1)]) {
    assert.match(soql.$where, /estado_contrato not in \('Borrador', 'Cancelado'\)/);
    assert.match(soql.$where, /^nit_entidad = 890905211 AND /);
    assert.doesNotMatch(soql.$select.replace("count(distinct documento_proveedor)", ""), /documento/);
  }
  assert.equal(queries.contracts(NIT, 2024, 3).$offset, "40");
});

test("an entity comes with its years, without mistyped dates", async (t) => {
  const { get } = await start(t);
  const { status, body } = await get(`/entities/${NIT}`);
  assert.equal(status, 200);
  assert.equal(body.name, "DISTRITO DE MEDELLÍN");
  assert.deepEqual(body.years, [{ year: 2023, contracts: 10, total: 1000.5 }, { year: 2024, contracts: 12, total: 3000 }]);
});

test("the overview has typed numbers, twelve months and the largest contract", async (t) => {
  const { get } = await start(t);
  const { status, body, headers } = await get(`/entities/${NIT}/overview?year=2024`);
  assert.equal(status, 200);
  assert.deepEqual({ contracts: body.contracts, total: body.total, largest: body.largest, suppliers: body.suppliers },
                   { contracts: 12, total: 3000, largest: 2500, suppliers: 7 });
  assert.deepEqual(body.topSuppliers, [{ name: "ACME SAS", contracts: 3, total: 2600 }]);
  assert.equal(body.byMonth.length, 12);
  assert.deepEqual(body.byMonth[2], { month: 3, contracts: 12, total: 3000 });
  assert.deepEqual(body.byMonth[0], { month: 1, contracts: 0, total: 0 });
  assert.equal(headers.get("access-control-allow-origin"), "*");
});

test("contracts are paginated and only link back to SECOP", async (t) => {
  const { get, sent } = await start(t);
  const { body } = await get(`/entities/${NIT}/contracts?year=2024&page=2`);
  assert.equal(body.items.length, 20);
  assert.equal(body.hasMore, true); // the fake returned the extra 21st row
  assert.equal(sent[0].get("$offset"), "20");
  assert.equal(body.items[0].url, null); // a URL outside secop.gov.co is dropped
  assert.match(body.items[1].url, /^https:\/\/community\.secop\.gov\.co\//);
  assert.equal(body.items[1].signedOn, "2024-03-05");
});

test("repeated requests are served from the cache", async (t) => {
  const { get, sent } = await start(t);
  await Promise.all([get(`/entities/${NIT}/overview?year=2024`), get(`/entities/${NIT}/overview?year=2024`)]);
  await get(`/entities/${NIT}/overview?year=2024`);
  assert.equal(sent.length, 4); // four queries for the first request, none for the other two
});

test("bad input, unknown entities and unknown routes get clear errors and send nothing upstream", async (t) => {
  const { get, sent } = await start(t);
  assert.equal((await get("/entities/1%20OR%201=1")).status, 400);
  assert.equal((await get(`/entities/${NIT}/overview?year=1999`)).status, 400);
  assert.equal((await get(`/entities/${NIT}/contracts?year=2024&page=0`)).status, 400);
  assert.equal((await get("/entities/123456789")).status, 404);
  assert.equal((await get("/nope")).status, 404);
  assert.deepEqual((await get("/entities?q=medellin")).body.items.map((e: any) => e.nit), [800194096, NIT]);
  assert.equal(sent.length, 0);
});

test("upstream failures become 502 and 504, are not cached, and leak no detail", async (t) => {
  let calls = 0;
  const failing = (async () => {
    calls++;
    if (calls === 1) return new Response("secret upstream stack trace", { status: 500 });
    throw new DOMException("timed out", "TimeoutError");
  }) as typeof fetch;
  const { get } = await start(t, { fetch: failing });
  const first = await get(`/entities/${NIT}`);
  assert.equal(first.status, 502);
  assert.doesNotMatch(JSON.stringify(first.body), /secret/);
  assert.equal((await get(`/entities/${NIT}`)).status, 504);
  assert.equal(calls, 2); // the failure was retried, not served from the cache
});

test("a client is limited to 60 requests a minute", async (t) => {
  let clock = Date.UTC(2026, 9, 1);
  const { get } = await start(t, { now: () => clock });
  const statuses = await Promise.all(Array.from({ length: 61 }, () => get("/health").then((r) => r.status)));
  assert.equal(statuses.filter((status) => status === 200).length, 60);
  assert.equal(statuses.filter((status) => status === 429).length, 1);
  clock += 60_000;
  assert.equal((await get("/health")).status, 200);
});

test("live: datos.gov.co accepts every query", { skip: !process.env.LIVE }, async () => {
  for (const soql of [queries.years(NIT), queries.totals(NIT, 2024), queries.topSuppliers(NIT, 2024),
                      queries.byModality(NIT, 2024), queries.byMonth(NIT, 2024), queries.contracts(NIT, 2024, 1)]) {
    const response = await fetch(`${DATASET}?${new URLSearchParams(soql)}`);
    assert.equal(response.status, 200, JSON.stringify(soql));
    assert.ok((await response.json()).length > 0);
  }
});
