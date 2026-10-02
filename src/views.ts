// What a client receives: pure functions from the portal's rows to this API's JSON.
// The portal returns every value as a string and leaves empty ones out, so each field is read defensively.

import { fold } from "./entities.ts";
import { FIRST_YEAR, PAGE_SIZE } from "./soql.ts";
import type { Row } from "./upstream.ts";

const SECOP_URL = /^https:\/\/([a-z0-9-]+\.)*secop\.gov\.co\//i;
export const NO_MODALITY = "Sin modalidad"; // how a contract with no modality recorded is shown and asked for

/**
 * How a modality awards a contract: without a public call (direct), by competition (competitive),
 * under a regime of the entity's own (special), or none of those. The dataset spells modalities
 * several ways ("Contratación Directa (con ofertas)"), so the rule reads words, not exact names.
 */
export type AwardMethod = "direct" | "competitive" | "special" | "other";

export function awardMethod(modality: string): AwardMethod {
  const text = fold(modality);
  if (text.includes("enajenacion")) return "other"; // the state selling its goods, not buying
  if (text.includes("regimen especial")) return "special";
  if (text.includes("directa")) return "direct";
  if (/licitacion|seleccion abreviada|concurso|minima cuantia/.test(text)) return "competitive";
  return "other";
}

const totals = (row: Row | undefined) => ({ contracts: Number(row?.contratos ?? 0), total: Number(row?.total ?? 0) });

/** Years with contracts. `largest` lets a client see when one mistyped contract explains a year. */
export function toYears(rows: Row[], thisYear: number) {
  return rows
    .map((row) => ({ year: Number(row.anio), ...totals(row), largest: Number(row.mayor ?? 0) }))
    .filter(({ year }) => year >= FIRST_YEAR && year <= thisYear); // drops mistyped signing dates
}

export function toOverview(nit: number, year: number, rows: { totals: Row[]; suppliers: Row[]; modalities: Row[]; months: Row[] }) {
  const byMonth = new Map(rows.months.map((row) => [Number(row.mes), row]));
  return {
    nit, year,
    ...totals(rows.totals[0]),
    // The values are typed by hand and some are off by orders of magnitude, so a client
    // needs the largest single contract to judge how much of the total to believe.
    largest: Number(rows.totals[0]?.mayor ?? 0),
    suppliers: Number(rows.totals[0]?.proveedores ?? 0),
    topSuppliers: rows.suppliers.map((row) => ({ name: String(row.proveedor ?? "").trim(), ...totals(row) })),
    byModality: rows.modalities.map((row) => {
      const modality = String(row.modalidad ?? NO_MODALITY);
      return { modality, method: awardMethod(modality), ...totals(row) };
    }),
    byMonth: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, ...totals(byMonth.get(i + 1)) })),
  };
}

function toContract(row: Row) {
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
}

/** The query asks for one row more than a page, which is how `hasMore` is known without a count. */
export function toContractPage(rows: Row[]) {
  return { pageSize: PAGE_SIZE, hasMore: rows.length > PAGE_SIZE, items: rows.slice(0, PAGE_SIZE).map(toContract) };
}
