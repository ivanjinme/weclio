import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { createResourceTicketSigner } = await createJiti(import.meta.url).import("./resource-ticket.ts");

test("resource tickets: signed bash source requires download and a session", () => {
  const signer = createResourceTicketSigner("instance");
  const resource = { source: "bash-output", filePath: "/tmp/pi-bash-test.log", kind: "download", sessionId: "session-a" };
  const { ticket } = signer.issue(resource);
  assert.deepEqual(signer.verify(ticket), resource);
  for (const invalid of [
    { ...resource, source: "unknown" }, { ...resource, source: null },
    { ...resource, kind: "read" }, { ...resource, kind: "preview" },
    { ...resource, sessionId: "" }, { ...resource, sessionId: " " },
    { ...resource, sessionId: null }, { ...resource, sessionId: undefined },
  ]) assert.throws(() => signer.verify(signer.issue(invalid).ticket), /Invalid or expired/);
  const [payload, signature] = ticket.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  for (const changed of [{ ...claims, source: undefined }, { ...claims, kind: "read" }]) {
    const forged = Buffer.from(JSON.stringify(changed)).toString("base64url") + "." + signature;
    assert.throws(() => signer.verify(forged), /Invalid or expired/);
  }
});

test("resource tickets: fixed lifetime, tamper, malformed, oversized, audience and key rotation", () => {
  let now = 1_000_000;
  const signer = createResourceTicketSigner("instance-a", () => now);
  const resource = { filePath: "/allowed/a.pdf", kind: "read", sessionId: "session-a" };
  const { ticket, expiresAt } = signer.issue(resource);
  assert.equal(expiresAt, now + 15 * 60 * 1000);
  assert.deepEqual(signer.verify(ticket), resource);
  for (const bad of ["", "abc.def", ticket + "x", "x".repeat(20_000), "!" + ticket.slice(1),
    ticket.replace(/^./, ticket[0] === "e" ? "f" : "e")]) {
    assert.throws(() => signer.verify(bad), /Invalid or expired/);
  }
  assert.throws(() => createResourceTicketSigner("instance-a", () => now).verify(ticket), /Invalid or expired/);
  assert.throws(() => createResourceTicketSigner("instance-b", () => now).verify(ticket), /Invalid or expired/);
  now = expiresAt - 1;
  assert.deepEqual(signer.verify(ticket), resource);
  now = expiresAt;
  assert.throws(() => signer.verify(ticket), /Invalid or expired/);
});
