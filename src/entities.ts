// The entity directory. Searching entity names upstream means a LIKE over six million rows
// (about 90 seconds), so the directory is a snapshot searched in memory instead.

import { readFileSync } from "node:fs";

export type Entity = { nit: number; name: string; department: string; level: string; contracts: number };
type StoredEntity = Entity & { aliases: string[] };

type DirectoryRow = { nit_entidad?: string; nombre_entidad?: string; departamento?: string; orden?: string; contratos?: string };

const fold = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * One entity per NIT. The dataset spells an entity several ways, and a city's departments often
 * publish under the city's NIT: the commonest spelling becomes the name, the rest stay searchable.
 */
export function mergeDirectory(rows: DirectoryRow[]): StoredEntity[] {
  const byNit = new Map<number, StoredEntity & { top: number }>();
  for (const row of rows) {
    const nit = Number(row.nit_entidad);
    const contracts = Number(row.contratos);
    const name = row.nombre_entidad?.trim();
    if (!Number.isInteger(nit) || nit <= 0 || !name) continue;
    const seen = byNit.get(nit);
    if (!seen) {
      byNit.set(nit, { nit, name, department: row.departamento ?? "", level: row.orden ?? "", contracts,
                       aliases: [], top: contracts });
    } else {
      seen.contracts += contracts;
      if (contracts > seen.top) {
        seen.aliases.push(seen.name);
        Object.assign(seen, { name, top: contracts });
      } else {
        seen.aliases.push(name);
      }
    }
  }
  return [...byNit.values()].map(({ top, ...entity }) => entity).sort((a, b) => b.contracts - a.contracts);
}

export class Directory {
  readonly #entities: Entity[];
  readonly #searchable: string[];
  readonly #byNit: Map<number, Entity>;

  constructor(stored: StoredEntity[]) {
    this.#entities = stored.map(({ aliases, ...entity }) => entity); // already sorted by number of contracts
    this.#searchable = stored.map((entity) => fold([entity.name, ...entity.aliases].join(" | ")));
    this.#byNit = new Map(this.#entities.map((entity) => [entity.nit, entity]));
  }

  static fromFile(path: string | URL): Directory {
    return new Directory(JSON.parse(readFileSync(path, "utf8")));
  }

  get size(): number {
    return this.#entities.length;
  }

  get(nit: number): Entity | undefined {
    return this.#byNit.get(nit);
  }

  /** Entities with every word of the query in one of their spellings, ignoring case and accents; biggest first. */
  search(query: string, limit = 10): Entity[] {
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (words.join("").length < 3) return [];
    const found: Entity[] = [];
    for (let i = 0; i < this.#entities.length && found.length < limit; i++) {
      if (words.every((word) => this.#searchable[i].includes(word))) found.push(this.#entities[i]);
    }
    return found;
  }
}
