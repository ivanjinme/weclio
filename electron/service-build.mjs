import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { copyProductionDependency } from "./package-files.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SEEDS = ["@weclio/plugins", "weclio-cli"];
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const slash = (value) => value.split(sep).join("/");
const inside = (root, file) => { const name = relative(root, file); return name !== ".." && !name.startsWith(`..${sep}`) && !name.startsWith(sep) && !/^[a-z]:/i.test(name); };
const packageName = (specifier) => specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];

function sourceFile(root, from, specifier) {
  const base = specifier.startsWith("@/") ? join(root, specifier.slice(2)) : resolve(dirname(from), specifier);
  const file = [base, ...[".ts", ".tsx", ".mjs", ".js", "/index.ts", "/index.js"].map((suffix) => base + suffix)]
    .find((candidate) => existsSync(candidate) && !/\.d\.ts$/.test(candidate) && /\.(?:[cm]?[jt]sx?|json)$/.test(candidate));
  if (!file || !inside(root, realpathSync(file))) throw new Error(`Unresolved or external Service source: ${specifier} from ${from}`);
  return file;
}

/** 编译自己的运行时引用图；不打包 SDK，以保留其动态 TS 扩展与磁盘资源布局。 */
export function compileServiceSources(root, entries = ["lib/agent/service/entry.ts", "electron/packages.mjs"]) {
  const pending = entries.map((entry) => resolve(root, entry));
  const output = new Map();
  const dependencies = new Set();
  const outputPath = (file) => slash(relative(root, file)).replace(/\.(?:tsx?|jsx?)$/, ".js");
  while (pending.length) {
    const file = pending.pop();
    if (output.has(outputPath(file))) continue;
    if (file.endsWith(".json")) { output.set(outputPath(file), readFileSync(file, "utf8")); continue; }
    const javascript = ts.transpileModule(readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const source = ts.createSourceFile(file + ".js", javascript, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const replacements = [];
    function visit(node) {
      let specifier;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specifier = node.moduleSpecifier;
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0])) throw new Error(`Nonliteral Service import: ${file}`);
        specifier = node.arguments[0];
      }
      if (specifier && ts.isStringLiteral(specifier)) {
        const value = specifier.text;
        if (value.startsWith(".") || value.startsWith("@/")) {
          const target = sourceFile(root, file, value);
          pending.push(target);
          const route = slash(relative(dirname(outputPath(file)), outputPath(target)));
          replacements.push({ start: specifier.getStart(source), end: specifier.end, value: JSON.stringify(route.startsWith(".") ? route : `./${route}`) });
        } else if (!isBuiltin(value)) {
          const name = packageName(value);
          if (["next", "electron", "electron-updater", "react", "react-dom"].includes(name)) throw new Error(`UI/host dependency in Service: ${value}`);
          dependencies.add(name);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    let emitted = javascript;
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) emitted = emitted.slice(0, replacement.start) + replacement.value + emitted.slice(replacement.end);
    output.set(outputPath(file), emitted);
  }
  return { output, dependencies: [...dependencies].sort() };
}

/** 从已安装且与根锁一致的包收集生产闭包；不按根 devDependency 标记误删运行时模块。 */
export function collectDependencies(root, names) {
  const modules = realpathSync(join(root, "node_modules"));
  const lock = json(join(root, "package-lock.json"));
  const pending = names.map((name) => ({ name, from: join(root, "package.json"), optional: false }));
  const packages = new Map();
  const direct = {};
  for (const item of pending) {
    const require = createRequire(item.from);
    const manifest = require.resolve.paths(`${item.name}/package.json`)?.map((base) => join(base, item.name, "package.json")).find(existsSync);
    if (!manifest && item.optional) continue;
    if (!manifest) throw new Error(`Missing runtime dependency ${item.name} required by ${item.from}`);
    const directory = realpathSync(dirname(manifest));
    if (!inside(modules, directory) || directory === modules) throw new Error(`Linked dependency outside node_modules: ${directory}`);
    const name = slash(relative(root, directory));
    const metadata = json(manifest);
    const locked = lock.packages?.[name];
    if (!locked || locked.link || locked.version !== metadata.version) throw new Error(`Installed dependency differs from package-lock: ${name}`);
    if (item.from === join(root, "package.json")) direct[item.name] = metadata.version;
    if (packages.has(directory)) continue;
    packages.set(directory, { path: name, name: metadata.name, version: metadata.version, integrity: locked.integrity });
    const required = { ...metadata.peerDependencies, ...metadata.dependencies, ...metadata.optionalDependencies };
    for (const dependency of Object.keys(required)) pending.push({
      name: dependency, from: manifest,
      optional: Object.hasOwn(metadata.optionalDependencies ?? {}, dependency) || metadata.peerDependenciesMeta?.[dependency]?.optional === true,
    });
  }
  return { packages, direct };
}

export async function copyDependencyClosure(root, destination, names) {
  const closure = collectDependencies(root, names);
  const copied = [];
  for (const source of [...closure.packages.keys()].sort((a, b) => a.length - b.length)) {
    if (copied.some((parent) => source.startsWith(parent + sep))) continue;
    await copyProductionDependency(source, join(destination, relative(root, source)));
    copied.push(source);
  }
  return closure;
}

/** 输出目录必须新建，避免混入上一次产物、开发文件或用户配置。 */
export async function buildServiceArtifact({ root = ROOT, destination }) {
  if (!destination) throw new Error("Service destination is required");
  await mkdir(destination, { recursive: false });
  const compiled = compileServiceSources(root);
  const metadata = json(join(root, "package.json"));
  const closure = await copyDependencyClosure(root, destination, [...new Set([...compiled.dependencies, ...SEEDS])]);
  for (const [name, content] of compiled.output) {
    await mkdir(dirname(join(destination, name)), { recursive: true });
    await writeFile(join(destination, name), content);
  }
  await cp(join(root, "LICENSE"), join(destination, "LICENSE"));
  await writeFile(join(destination, "package.json"), JSON.stringify({
    name: "@weclio/agent-service", private: true, type: "module", version: metadata.version,
    engines: metadata.engines, dependencies: closure.direct,
  }, null, 2) + "\n");
  await writeFile(join(destination, "entry.mjs"), `import { dirname } from "node:path";\nimport { fileURLToPath } from "node:url";\nimport { initializeDesktopPackages } from "./electron/packages.mjs";\nimport { main } from "./lib/agent/service/entry.js";\nprocess.env.WECLIO_AGENT_VERSION ??= ${JSON.stringify(metadata.version)};\nawait initializeDesktopPackages(dirname(fileURLToPath(import.meta.url)));\nawait main();\n`);
  const manifest = {
    schema: 1, version: metadata.version,
    sourceLockSha256: createHash("sha256").update(readFileSync(join(root, "package-lock.json"))).digest("hex"),
    sources: [...compiled.output.keys()].sort(),
    packages: [...closure.packages.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
  await writeFile(join(destination, "service-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

export async function buildHostArtifact({ root = ROOT, destination }) {
  await mkdir(destination, { recursive: false });
  const closure = await copyDependencyClosure(root, destination, ["electron-updater"]);
  const metadata = json(join(root, "package.json"));
  await writeFile(join(destination, "package.json"), JSON.stringify({ name: "@weclio/desktop-host", private: true, version: metadata.version, dependencies: closure.direct }, null, 2) + "\n");
  await writeFile(join(destination, "host-manifest.json"), JSON.stringify({ schema: 1, packages: [...closure.packages.values()] }, null, 2) + "\n");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const destination = resolve(process.argv[2] ?? "build/service");
  await mkdir(dirname(destination), { recursive: true });
  const manifest = await buildServiceArtifact({ destination });
  console.log(`[service-build] ${manifest.sources.length} source files, ${manifest.packages.length} runtime packages → ${destination}`);
}
