export function shouldRefuseDirectReload(isRunning: boolean, manualCompactionRunning: boolean): boolean {
  return isRunning || manualCompactionRunning;
}

/** An extension command runs inside its own prompt, which does not itself block reload. */
export function extensionReloadBlockReason(
  isStreaming: boolean,
  isCompacting: boolean,
  manualCompactionRunning: boolean,
): string | null {
  if (isStreaming) return "Wait for the current response to finish before reloading.";
  if (isCompacting || manualCompactionRunning) return "Wait for compaction to finish before reloading.";
  return null;
}
