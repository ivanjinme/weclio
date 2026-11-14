import fs from "node:fs";
import path from "node:path";

export type ModelsConfig = Record<string, unknown>;

function isRecord(value: unknown): value is ModelsConfig {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readModelsJsonFile(filePath: string): ModelsConfig {
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { providers: {} };
    }
    throw error;
  }
  // Pi's own config readers accept UTF-8 BOM; a truncated or invalid file
  // must not be silently interpreted as an empty user configuration.
  const decoded = contents.replace(/^\uFEFF/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch (error) {
    throw new Error(`Invalid models.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("Invalid models.json: expected an object");
  return parsed;
}

/** Atomic, same-directory write that does not discard a corrupt existing config. */
export function writeModelsJsonFile(filePath: string, data: unknown): void {
  if (!isRecord(data)) throw new Error("Invalid models.json: expected an object");
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });

  // Fail closed when an existing file is corrupt or points through a symlink.
  // A failed or interrupted save must never erase the last valid config.
  let originalMode = 0o600;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Cannot replace models.json unless it is a regular file");
    }
    readModelsJsonFile(filePath);
    originalMode = stat.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const tempDir = fs.mkdtempSync(path.join(parent, ".weclio-models-"));
  const tempFile = path.join(tempDir, "models.json");
  try {
    const fd = fs.openSync(tempFile, "wx", originalMode);
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2) + "\n", "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tempFile, originalMode);
    fs.renameSync(tempFile, filePath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
