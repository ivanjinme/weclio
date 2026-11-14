/**
 * One OAuth login event stream's writer. Provider/extension notifications can
 * arrive after a browser disconnects or login completes, so writes must never
 * throw out of asynchronous callbacks when the stream has already closed.
 */
export function createOAuthSseWriter() {
  const encoder = new TextEncoder();
  let closed = false;

  return {
    send(controller: ReadableStreamDefaultController<Uint8Array>, data: unknown): void {
      if (closed) return;
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\\n\\n`));
      } catch {
        closed = true;
      }
    },
    close(controller: ReadableStreamDefaultController<Uint8Array>): void {
      if (closed) return;
      closed = true;
      try {
        controller.close();
      } catch {
        // The browser or stream runtime may have already closed the controller.
      }
    },
    markClosed(): void {
      closed = true;
    },
  };
}
