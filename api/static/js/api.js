// Network: one Server-Sent Events stream for live state, plus small JSON helpers.

async function call(method, url, body) {
  try {
    const r = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    let data = null;
    try { data = await r.json(); } catch { /* empty body */ }
    const message = data?.message || data?.detail?.[0]?.msg || data?.detail || `Request failed (${r.status})`;
    return { ok: r.ok, status: r.status, data, message: typeof message === "string" ? message : "Request failed" };
  } catch {
    return { ok: false, status: 0, data: null, message: "The control server is not reachable." };
  }
}

export const api = {
  get: (u) => call("GET", u),
  post: (u, b) => call("POST", u, b),
  put: (u, b) => call("PUT", u, b),
  del: (u) => call("DELETE", u),
};

/** Live state. EventSource reconnects by itself, so if an API pod dies the stream
 *  simply resumes from the other pod. Falls back to polling where SSE is missing. */
export function connect(onState, onConn) {
  if (!("EventSource" in window)) {
    const poll = async () => {
      const r = await call("GET", "/api/state");
      if (r.ok) { onConn("live"); onState(r.data); } else onConn("lost");
      setTimeout(poll, 800);
    };
    poll();
    return;
  }
  const es = new EventSource("/api/stream");
  es.addEventListener("state", (e) => { onConn("live"); onState(JSON.parse(e.data)); });
  es.addEventListener("error", () => onConn("lost"));
}
