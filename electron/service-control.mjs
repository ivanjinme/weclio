const PREFIX = "WECLIO_AGENT_CONTROL ";

/** 仅绑定 Main 自有子进程的管道；不接受 endpoint/Bearer，也不暴露给 renderer。 */
export function createServiceControl({ write, timeoutMs = 5000 }) {
  let sequence = 0;
  let disconnected = false;
  const pending = new Map();
  function finish(id, error, status) {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    if (error) request.reject(error);
    else request.resolve(status);
  }
  function request(action) {
    if (disconnected) return Promise.reject(new Error("Service control channel unavailable"));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(id, new Error("Service control request timed out")), timeoutMs);
      pending.set(id, { action, resolve, reject, timer });
      try { write(JSON.stringify({ id, action }) + "\n"); }
      catch { finish(id, new Error("Service control channel unavailable")); }
    });
  }
  function malformed() {
    for (const id of pending.keys()) finish(id, new Error("Malformed Service control reply"));
  }
  return {
    inspect: () => request("inspect"),
    lock: () => request("lock"),
    unlock: () => request("unlock"),
    onLine(line) {
      if (!line.startsWith(PREFIX)) return false;
      let reply;
      try { reply = JSON.parse(line.slice(PREFIX.length)); }
      catch { malformed(); return true; }
      if (!reply || typeof reply !== "object" || !Number.isSafeInteger(reply.id)) { malformed(); return true; }
      const request = pending.get(reply.id);
      // 超时后的迟到响应不能解锁/推进后续请求，也不能被当作新的 ready。
      if (!request) return true;
      const allowed = request.action === "unlock" ? ["unlocked"] : ["ready", "busy"];
      if (!allowed.includes(reply.status)) finish(reply.id, new Error("Malformed Service control reply"));
      else finish(reply.id, undefined, reply.status);
      return true;
    },
    disconnect() {
      disconnected = true;
      for (const id of pending.keys()) finish(id, new Error("Service control channel unavailable"));
    },
  };
}
