import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const content = `// AUTO-GENERATED from package.json — do not edit.
export const VERSION = ${JSON.stringify(pkg.version)};
`;
writeFileSync(join(root, "src/core/version.ts"), content);
