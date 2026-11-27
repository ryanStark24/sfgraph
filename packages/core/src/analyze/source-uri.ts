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

/**
 * A SARIF `artifactLocation.uri` must be an RFC 3986 URI reference (OASIS SARIF 2.1.0, format
 * `uri-reference`). A raw path with spaces, `#`, `%` or non-ASCII characters is not one. Each path
 * segment is percent-encoded with `encodeURIComponent`; `/` separators, the `file://` prefix and
 * a Windows drive segment (`C:`) are kept. Input is a raw (decoded) path or `file://` URI as the
 * graph stores it, so a `%` in the input is a literal percent and becomes `%25`. A URI with a
 * scheme other than `file` is left alone.
 */
export function toUriReference(uri: string): string {
  const normalized = normalizeSourceUri(uri);
  let prefix = "";
  let rest = normalized;
  if (normalized.startsWith("file://")) {
    prefix = "file://";
    rest = normalized.slice(prefix.length);
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(normalized)) {
    return normalized;
  }
  const encoded = rest
    .split("/")
    .map((seg) => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join("/");
  return prefix + encoded;
}

const URI_REFERENCE_CHARS = /^(?:[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]|%[0-9A-Fa-f]{2})*$/;

/** Why `uri` is not a valid URI reference, or undefined when it is. */
export function uriReferenceProblem(uri: string): string | undefined {
  if (!URI_REFERENCE_CHARS.test(uri)) {
    return "contains characters that must be percent-encoded (spaces, non-ASCII, or a bare %)";
  }
  try {
    new URL(uri, "file:///");
  } catch {
    return "does not parse as a URI reference";
  }
  return undefined;
}
