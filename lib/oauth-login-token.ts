import { randomUUID } from "node:crypto";

/** Unpredictable one-time token for a pending manual OAuth input request. */
export function createManualLoginToken(provider: string): string {
  return `${provider}-${randomUUID()}`;
}
