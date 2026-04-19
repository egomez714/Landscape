// Small helper for POST-based SSE streams (EventSource is GET-only, so we
// can't use it for the expansion endpoint which carries a JSON body).
// Normalizes CRLF, splits on blank lines, parses `event:` / `data:` fields.

export type SSEFrame<T = unknown> = { event: string; data: T };

export async function* postSSEStream<T = unknown>(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<SSEFrame<T>, void, void> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      // ignore — body may be unreadable
    }
    throw new Error(
      `SSE POST failed: HTTP ${res.status} ${res.statusText}${
        body ? ` — ${body.slice(0, 400)}` : ""
      }`,
    );
  }
  if (!res.body) {
    throw new Error("SSE response has no body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      buf = buf.replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const frame = parseFrame<T>(raw);
        if (frame) yield frame;
      }
    }
  } finally {
    try {
      reader.cancel();
    } catch {
      // ignore
    }
  }
}

function parseFrame<T>(raw: string): SSEFrame<T> | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^\s/, ""));
    }
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) as T };
  } catch {
    return null;
  }
}
