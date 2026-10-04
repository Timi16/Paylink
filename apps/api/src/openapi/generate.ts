import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildOpenApiDocument } from "./registry";

// `npm run openapi`: writes openapi.json next to package.json.
const out = resolve(process.cwd(), "openapi.json");
writeFileSync(out, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`wrote ${out}`);
