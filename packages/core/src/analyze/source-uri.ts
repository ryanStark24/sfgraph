/**
 * One spelling for the `file` of a code-check finding. The filesystem extractor writes
 * `file://${absolutePath}`, which on Windows is `file://C:\Users\x\proj\lwc\bundle` (backslashes,
 * no slash before the drive). Findings carry a forward-slash URI (`file:///C:/Users/x/...`),
 * so a bundle file can be appended with `/` and a consumer can strip the project root the same way
 * on every platform. POSIX URIs are unchanged.
 */
export function normalizeSourceUri(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  const path = uri.slice("file://".length).replace(/\\/g, "/");
  // `C:/x` or `/C:/x` -> `/C:/x`; `//server/share` and POSIX `/x` stay as they are.
  return `file://${/^[A-Za-z]:\//.test(path) ? `/${path}` : path}`;
}
