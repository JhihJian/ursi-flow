/** pi-web 嵌入模式：作为 iframe 嵌入 shell-web 等宿主时通过 `?embed=1` 启用。 */
export function isEmbedMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("embed") === "1";
  } catch {
    return false;
  }
}
