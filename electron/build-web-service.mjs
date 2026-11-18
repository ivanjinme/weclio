import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildServiceArtifact } from "../electron/service-build.mjs";

const parent = new URL("../build/web-package/", import.meta.url);
const destination = fileURLToPath(new URL("service", parent));
await mkdir(parent, { recursive: true });
await rm(destination, { recursive: true, force: true });
const manifest = await buildServiceArtifact({ destination });
console.log(`[web-service] ${manifest.sources.length} sources, ${manifest.packages.length} runtime packages`);
