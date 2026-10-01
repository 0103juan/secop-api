// Every query this API can send to datos.gov.co. Callers pass numbers that were already
// validated; nothing a client types is ever concatenated into SoQL.

export const DATASET = "https://www.datos.gov.co/resource/jbjy-vk9h.json"; // SECOP II - Contratos Electrónicos
export const FIRST_YEAR = 2015;
export const PAGE_SIZE = 20;
export const MAX_PAGE = 500;

// Drafts and cancelled contracts are not money the entity committed.
const LIVE = "estado_contrato not in ('Borrador', 'Cancelado')";

export type Soql = Record<string, string>;

export class BadRequest extends Error {}

/** A NIT as the dataset stores it: digits only, no check digit. */
export function parseNit(raw: string): number {
  if (!/^\d{5,12}$/.test(raw)) throw new BadRequest("nit must be 5 to 12 digits");
  return Number(raw);
}

export function parseYear(raw: string | null, now = new Date()): number {
  const year = Number(raw);
  if (!Number.isInteger(year) || year < FIRST_YEAR || year > now.getFullYear()) {
    throw new BadRequest(`year must be an integer between ${FIRST_YEAR} and ${now.getFullYear()}`);
  }
  return year;
}

export function parsePage(raw: string | null): number {
  const page = raw === null ? 1 : Number(raw);
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) {
    throw new BadRequest(`page must be an integer between 1 and ${MAX_PAGE}`);
  }
  return page;
}

function signedIn(nit: number, year: number): string {
  // A date range instead of date_extract_y(...) = year, so the filter can use the column as stored.
  return `nit_entidad = ${nit} AND fecha_de_firma >= '${year}-01-01T00:00:00' ` +
    `AND fecha_de_firma < '${year + 1}-01-01T00:00:00' AND ${LIVE}`;
}

export const queries = {
  /** One row per (NIT, spelling of the name). Scans the whole dataset: about 90 seconds. */
  directory: (): Soql => ({
    $select: "nit_entidad, nombre_entidad, departamento, orden, count(*) as contratos",
    $group: "nit_entidad, nombre_entidad, departamento, orden",
    $order: "contratos DESC",
    $limit: "50000",
  }),
  years: (nit: number): Soql => ({
    $select: "date_extract_y(fecha_de_firma) as anio, count(*) as contratos, sum(valor_del_contrato) as total",
    $where: `nit_entidad = ${nit} AND fecha_de_firma IS NOT NULL AND ${LIVE}`,
    $group: "anio",
    $order: "anio ASC",
    $limit: "50",
  }),
  totals: (nit: number, year: number): Soql => ({
    $select: "count(*) as contratos, sum(valor_del_contrato) as total, max(valor_del_contrato) as mayor, " +
      "count(distinct documento_proveedor) as proveedores",
    $where: signedIn(nit, year),
  }),
  // Suppliers are grouped by document number because their names are typed inconsistently,
  // but the number itself (often a person's cédula) is never selected into a response.
  topSuppliers: (nit: number, year: number): Soql => ({
    $select: "max(proveedor_adjudicado) as proveedor, count(*) as contratos, sum(valor_del_contrato) as total",
    $where: signedIn(nit, year),
    $group: "documento_proveedor",
    $order: "total DESC",
    $limit: "10",
  }),
  byModality: (nit: number, year: number): Soql => ({
    $select: "modalidad_de_contratacion as modalidad, count(*) as contratos, sum(valor_del_contrato) as total",
    $where: signedIn(nit, year),
    $group: "modalidad_de_contratacion",
    $order: "total DESC",
    $limit: "30",
  }),
  byMonth: (nit: number, year: number): Soql => ({
    $select: "date_extract_m(fecha_de_firma) as mes, count(*) as contratos, sum(valor_del_contrato) as total",
    $where: signedIn(nit, year),
    $group: "mes",
    $order: "mes ASC",
    $limit: "12",
  }),
  contracts: (nit: number, year: number, page: number): Soql => ({
    $select: "id_contrato, referencia_del_contrato, objeto_del_contrato, proveedor_adjudicado, valor_del_contrato, " +
      "fecha_de_firma, estado_contrato, modalidad_de_contratacion, tipo_de_contrato, urlproceso",
    $where: signedIn(nit, year),
    $order: "valor_del_contrato DESC, id_contrato ASC",
    $limit: String(PAGE_SIZE + 1), // one extra row tells us whether there is a next page
    $offset: String((page - 1) * PAGE_SIZE),
  }),
};
