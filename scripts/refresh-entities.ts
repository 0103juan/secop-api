// Rebuild data/entities.json from datos.gov.co. One grouped query over the whole dataset: about 90 seconds.

import { writeFileSync } from "node:fs";
import { mergeDirectory } from "../src/entities.ts";
import { DATASET, queries } from "../src/soql.ts";

const response = await fetch(`${DATASET}?${new URLSearchParams(queries.directory())}`, {
  headers: { "User-Agent": "secop-api" },
  signal: AbortSignal.timeout(300_000),
});
if (!response.ok) throw new Error(`datos.gov.co answered HTTP ${response.status}`);
const entities = mergeDirectory(await response.json());
writeFileSync(new URL("../data/entities.json", import.meta.url), JSON.stringify(entities));
console.log(`${entities.length} entities written to data/entities.json`);
