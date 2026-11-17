import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AgentProtocolError } from "./protocol/validate";

export type ResourceTicketKind = "read" | "preview" | "download";
export interface ResourceTicketResource {
  filePath: string;
  kind: ResourceTicketKind;
  sessionId?: string | null;
  source?: "bash-output";
}

const TICKET_TTL_MS = 15 * 60 * 1000;
const MAX_TICKET_LENGTH = 16 * 1024;

/** 密钥只活在宿主内存中；重启后所有旧票据自然失效。 */
export function createResourceTicketSigner(instanceId: string, now: () => number = Date.now) {
  const secret = randomBytes(32);
  const sign = (payload: string) => createHmac("sha256", secret).update(payload).digest();
  const invalid = () => new AgentProtocolError("unauthorized", "Invalid or expired resource ticket");
  return {
    issue(resource: ResourceTicketResource): { ticket: string; expiresAt: number } {
      const expiresAt = now() + TICKET_TTL_MS;
      const payload = Buffer.from(JSON.stringify({
        v: 1, aud: instanceId, filePath: resource.filePath, kind: resource.kind, sessionId: resource.sessionId, source: resource.source, expiresAt,
      })).toString("base64url");
      const ticket = `${payload}.${sign(payload).toString("base64url")}`;
      if (ticket.length > MAX_TICKET_LENGTH) throw new AgentProtocolError("invalid_argument", "Resource path is too long");
      return { ticket, expiresAt };
    },
    verify(ticket: string): ResourceTicketResource {
      if (ticket.length > MAX_TICKET_LENGTH || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(ticket)) throw invalid();
      const [payload, signature] = ticket.split(".");
      const provided = Buffer.from(signature, "base64url");
      const expected = sign(payload);
      if (provided.toString("base64url") !== signature || provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw invalid();
      let value: unknown;
      try { value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw invalid(); }
      if (!value || typeof value !== "object") throw invalid();
      const claims = value as Record<string, unknown>;
      if (claims.v !== 1 || claims.aud !== instanceId
        || typeof claims.filePath !== "string" || !claims.filePath
        || typeof claims.kind !== "string" || !["read", "preview", "download"].includes(claims.kind)
        || (claims.sessionId !== undefined && claims.sessionId !== null && typeof claims.sessionId !== "string")
        || (claims.source !== undefined && claims.source !== "bash-output")
        || (claims.source === "bash-output" && (claims.kind !== "download" || typeof claims.sessionId !== "string" || !claims.sessionId.trim()))
        || typeof claims.expiresAt !== "number" || !Number.isSafeInteger(claims.expiresAt)
        || claims.expiresAt <= now() || claims.expiresAt > now() + TICKET_TTL_MS) throw invalid();
      return { filePath: claims.filePath, kind: claims.kind as ResourceTicketKind, sessionId: claims.sessionId as string | null | undefined,
        ...(claims.source === "bash-output" ? { source: "bash-output" as const } : {}) };
    },
  };
}
