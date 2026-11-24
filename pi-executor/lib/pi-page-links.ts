export type PiPage = "conversation" | "runtime" | "structure" | "prompt";

export function piHref(page: PiPage, sessionId?: string | null, entryId?: string | null) {
  const query = new URLSearchParams();
  if (sessionId) query.set("session", sessionId);
  if (entryId) query.set("entry", entryId);
  return `/${page}/${query.size ? `?${query}` : ""}`;
}

export function readPageId(query: { getAll(name: string): string[] }, key: "session" | "entry") {
  const values = query.getAll(key);
  if (!values.length) return null;
  const id = values[0];
  const valid = key === "session" ? /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) : id.trim() === id && id.length > 0 && id.length <= 128;
  return values.length === 1 && valid ? id : "";
}
