const STORAGE_KEY = "weclio:project-folders";
const HIDDEN_STORAGE_KEY = "weclio:hidden-project-folders";
export const PROJECT_FOLDERS_CHANGED_EVENT = "weclio:project-folders-changed";
export const PROJECT_FOLDER_CONFIRMED_EVENT = "weclio:project-folder-confirmed";

export interface ProjectFolderEntry {
  root: string;
  addedAt: string;
}

function loadArray(key: string): unknown[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveArray(key: string, values: readonly (string | ProjectFolderEntry)[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // Storage is optional; session cwd remains authoritative.
  }
}

export function projectPathKey(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

function notifyChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PROJECT_FOLDERS_CHANGED_EVENT));
}

export function loadProjectFolderEntries(): ProjectFolderEntry[] {
  return loadArray(STORAGE_KEY).flatMap((item) => {
    if (typeof item === "string") return [{ root: item, addedAt: "" }];
    if (item && typeof item === "object" && "root" in item && typeof item.root === "string"
      && "addedAt" in item && typeof item.addedAt === "string") {
      return [{ root: item.root, addedAt: item.addedAt }];
    }
    return [];
  });
}

export function loadProjectFolders(): string[] {
  return loadProjectFolderEntries().map(({ root }) => root);
}

export function loadHiddenProjectFolders(): string[] {
  return loadArray(HIDDEN_STORAGE_KEY).filter((item): item is string => typeof item === "string");
}

export function isProjectFolderHidden(root: string, hidden = loadHiddenProjectFolders()): boolean {
  const key = projectPathKey(root);
  return hidden.some((item) => projectPathKey(item) === key);
}

function hideProjectFolder(root: string): void {
  const hidden = loadHiddenProjectFolders();
  if (!isProjectFolderHidden(root, hidden)) saveArray(HIDDEN_STORAGE_KEY, [...hidden, root]);
  notifyChanged();
}

function unhideProjectFolder(root: string): void {
  const key = projectPathKey(root);
  const hidden = loadHiddenProjectFolders();
  const next = hidden.filter((item) => projectPathKey(item) !== key);
  if (next.length !== hidden.length) saveArray(HIDDEN_STORAGE_KEY, next);
  notifyChanged();
}

export function rememberProjectFolder(cwd: string): ProjectFolderEntry[] {
  const folders = loadProjectFolderEntries();
  const key = projectPathKey(cwd);
  const next = folders.some(({ root }) => projectPathKey(root) === key)
    ? folders
    : [...folders, { root: cwd, addedAt: new Date().toISOString() }];
  saveArray(STORAGE_KEY, next);
  unhideProjectFolder(cwd);
  return next;
}

export function replaceProjectFolder(previousRoot: string, nextRoot: string): ProjectFolderEntry[] {
  const folders = loadProjectFolderEntries();
  const previousKey = projectPathKey(previousRoot);
  const nextKey = projectPathKey(nextRoot);
  const previous = folders.find(({ root }) => projectPathKey(root) === previousKey);
  const remaining = folders.filter(({ root }) => projectPathKey(root) !== previousKey);
  const next = remaining.some(({ root }) => projectPathKey(root) === nextKey)
    ? remaining
    : [...remaining, { root: nextRoot, addedAt: previous?.addedAt ?? "" }];
  saveArray(STORAGE_KEY, next);
  unhideProjectFolder(nextRoot);
  return next;
}

export function forgetProjectFolder(root: string): ProjectFolderEntry[] {
  const key = projectPathKey(root);
  const next = loadProjectFolderEntries().filter((folder) => projectPathKey(folder.root) !== key);
  saveArray(STORAGE_KEY, next);
  hideProjectFolder(root);
  return next;
}
