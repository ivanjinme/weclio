import fs from "fs";
import path from "path";

export const UPLOAD_CONFLICT_STRATEGIES = ["error", "overwrite", "skip"] as const;
export type UploadConflictStrategy = typeof UPLOAD_CONFLICT_STRATEGIES[number];

const UPLOAD_CONFLICT_STRATEGY_SET = new Set<string>(UPLOAD_CONFLICT_STRATEGIES);

export interface UploadTargetInspection {
  conflicts: string[];
  nonReplaceable: string[];
}

export function parseUploadConflictStrategy(value: string | null): UploadConflictStrategy | null {
  const candidate = value ?? "error";
  return UPLOAD_CONFLICT_STRATEGY_SET.has(candidate)
    ? candidate as UploadConflictStrategy
    : null;
}

export function validateUploadFileNames(fileNames: string[]): string | null {
  if (fileNames.length === 0) return "No files selected";

  const seen = new Set<string>();
  for (const fileName of fileNames) {
    if (!fileName || fileName === "." || fileName === ".." || fileName.includes("\0")) {
      return `Invalid file name: ${fileName || "(empty)"}`;
    }
    if (fileName.includes("/") || fileName.includes("\\") || path.basename(fileName) !== fileName) {
      return `File names must not contain a path: ${fileName}`;
    }
    if (seen.has(fileName)) return `Duplicate file name in upload: ${fileName}`;
    seen.add(fileName);
  }

  return null;
}

export function inspectUploadTargets(directory: string, fileNames: string[]): UploadTargetInspection {
  const conflicts: string[] = [];
  const nonReplaceable: string[] = [];

  for (const fileName of fileNames) {
    const destination = path.join(directory, fileName);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw error;
    }

    conflicts.push(fileName);
    if (!stat.isFile() || stat.isSymbolicLink()) nonReplaceable.push(fileName);
  }

  return { conflicts, nonReplaceable };
}

/** Stage the complete replacement beside the destination before replacing it. */
export function replaceUploadFile(destination: string, bytes: Buffer): void {
  const original = fs.lstatSync(destination);
  if (!original.isFile() || original.isSymbolicLink()) {
    throw new Error("Cannot replace a directory or symbolic link");
  }

  // mkdtemp creates a private directory on the same filesystem as destination.
  const stageDir = fs.mkdtempSync(path.join(path.dirname(destination), ".pi-upload-"));
  const stagePath = path.join(stageDir, "upload");
  try {
    fs.writeFileSync(stagePath, bytes, { flag: "wx", mode: original.mode & 0o777 });
    // umask may otherwise strip mode bits (notably executable bits).
    fs.chmodSync(stagePath, original.mode & 0o777);
    const current = fs.lstatSync(destination);
    if (!current.isFile() || current.isSymbolicLink()) {
      throw new Error("Cannot replace a directory or symbolic link");
    }
    fs.renameSync(stagePath, destination);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}
