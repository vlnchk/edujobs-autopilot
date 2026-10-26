// Comparison of HTTP(S) links in editorial text, not intake or fetch validation.
// Self-contained so the builder embeds this exact function in n8n's URL-less VM.
export function extractCanonicalUrls(value) {
  const text = String(value ?? "");
  const urls = [];
  for (const match of text.matchAll(/https?:\/\//gi)) {
    const start = match.index;
    const quote = text[start - 1] === "'" ? "'" : null;
    const stack = [];
    const pairs = { "(": ")", "[": "]", "{": "}" };
    let end = start;
    for (; end < text.length; end += 1) {
      const character = text[end];
      if (/[\s<>"`“”‘’«»]/u.test(character) || character === quote) break;
      if (Object.hasOwn(pairs, character)) stack.push(pairs[character]);
      else if (/[)\]}]/.test(character)) {
        // An unmatched closer belongs to the prose/Markdown wrapper. Stop here,
        // even when prose immediately follows it; retain nested URL parentheses.
        if (stack.at(-1) !== character) break;
        stack.pop();
      }
    }
    // Only literal terminal prose punctuation is ambiguous. Interior punctuation,
    // balanced brackets and percent-encoded punctuation remain URL content.
    const candidate = text.slice(start, end).replace(/[.,;:!?'…]+$/u, "");
    const parts = /^(https?):\/\/([^/?#]+)(.*)$/i.exec(candidate);
    if (!parts) {
      urls.push(candidate); // Do not silently omit malformed editor-added links.
      continue;
    }
    const scheme = parts[1].toLowerCase();
    const authority = parts[2];
    const userInfoEnd = authority.lastIndexOf("@") + 1;
    const userInfo = authority.slice(0, userInfoEnd);
    let hostPort = authority.slice(userInfoEnd).toLowerCase();
    hostPort = hostPort.replace(scheme === "https" ? /:443$/ : /:80$/, "");
    let suffix = parts[3];
    if (!suffix.startsWith("/")) suffix = "/" + suffix;
    // Preserve query order/values, fragments, path case and reserved escapes.
    // Canonicalize Unicode spelling and percent escapes without decoding URL
    // separators (e.g. %2F must never become /).
    try {
      suffix = encodeURI(suffix).replace(/%25([\da-f]{2})/gi, "%$1");
    } catch { /* Keep malformed Unicode visible for comparison. */ }
    suffix = suffix.replace(/%[\da-f]{2}/gi, (escape) => {
      const decoded = String.fromCharCode(parseInt(escape.slice(1), 16));
      return /^[A-Za-z0-9_~-]$/.test(decoded) ? decoded : escape.toUpperCase();
    });
    urls.push(scheme + "://" + userInfo + hostPort + suffix);
  }
  return urls;
}
