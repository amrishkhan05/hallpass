import { chmod } from "node:fs/promises";
import { URL } from "node:url";

await chmod(new URL("../dist/cli/index.js", import.meta.url), 0o755);
