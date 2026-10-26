// Receives only the Project Link already accepted by intake. No fetching or identity inference.
// Self-contained for the n8n Code VM (which has no URL global).
export function insertProjectLink(body, selection, projectUrl) {
  const text = String(body ?? "");
  const fail = (issue) => ({ text, ok: false, issue, project_link_text: null });
  if (typeof selection !== "string" || !selection.trim()) return fail("Project mention is unresolved");
  if (typeof projectUrl !== "string" || !/^https?:\/\/[^/?#\s@]+(?:[/?#]|$)/i.test(projectUrl)) {
    return fail("No structurally valid submitted Project Link");
  }
  // Percent-encode Markdown delimiters and Unicode, preserving existing URL escapes.
  const encodeDestination = (url) => encodeURI(url).replace(/%25([\da-f]{2})/gi, "%$1")
      .replace(/[\\()[\]*_~!'<>"`]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  let destination;
  try {
    destination = encodeDestination(projectUrl);
  } catch { return fail("Unencodable Project Link"); }

  const chars = [];
  const containers = [];
  const escaped = (i) => {
    let count = 0;
    while (text[--i] === "\\") count++;
    return count % 2 === 1;
  };
  const add = (value, start, end, link = null, selectable = true) => {
    for (const c of value.split("")) chars.push({ c, start, end, link, selectable });
  };
  const closing = (needle, start, end) => {
    for (let i = start; i < end; i++) if (text.startsWith(needle, i) && !escaped(i)) return i;
    throw new Error("Unbalanced Markdown formatting");
  };
  function parse(start, end, link = null) {
    for (let i = start; i < end;) {
      const c = text[i];
      if (c === "\\" && /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(text[i + 1] ?? "")) {
        add(text[i + 1], i, i + 2, link); i += 2; continue;
      }
      if (c === "[") {
        let depth = 1, close = i + 1;
        for (; close < end; close++) {
          if (escaped(close)) continue;
          if (text[close] === "`") {
            const delimiter = /^`+/.exec(text.slice(close))[0];
            close = closing(delimiter, close + delimiter.length, end) + delimiter.length - 1;
            continue;
          }
          if (text[close] === "[") depth++;
          if (text[close] === "]" && --depth === 0) break;
          // Only brackets change the nesting depth.
          if (text[close] !== "]") continue;
        }
        if (close === end) throw new Error("Unbalanced Markdown bracket");
        if (text[close + 1] === "[" || text[close + 1] === ":" || (text[i - 1] === "!" && !escaped(i - 1))) {
          throw new Error("Unsupported reference link or image");
        }
        if (text[close + 1] === "(") {
          if (link) throw new Error("Nested Markdown link");
          let p = close + 2, depth = 1;
          for (; p < end; p++) {
            if (escaped(p)) continue;
            if (text[p] === "(") depth++;
            if (text[p] === ")" && --depth === 0) break;
          }
          if (p === end) throw new Error("Unbalanced Markdown destination");
          let url = text.slice(close + 2, p);
          if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1);
          if (!url || /\s/.test(url)) throw new Error("Ambiguous Markdown destination or title");
          const node = { kind: "link", start: i, end: p + 1, labelStart: i + 1, labelEnd: close,
            destinationStart: close + 2, destinationEnd: p, url, from: chars.length };
          parse(i + 1, close, node);
          node.to = chars.length; containers.push(node); i = p + 1; continue;
        }
        // Balanced literal brackets are visible (reference definitions are rejected above).
        add(c, i, i + 1, link); i++; continue;
      }
      if (c === "<") {
        const close = closing(">", i + 1, end);
        if (!/^https?:\/\/[^\s<>]+$/i.test(text.slice(i + 1, close))) throw new Error("Unsupported HTML formatting");
        add(text.slice(i + 1, close), i, close + 1, link, false); i = close + 1; continue;
      }
      if (c === "`") {
        const delimiter = /^`+/.exec(text.slice(i))[0];
        const close = closing(delimiter, i + delimiter.length, end);
        let value = text.slice(i + delimiter.length, close).replace(/\n/g, " ");
        // Inline code exposes literal text, with CommonMark's one-space padding rule.
        if (value.startsWith(" ") && value.endsWith(" ") && /\S/.test(value)) value = value.slice(1, -1);
        const node = { kind: "code", start: i, end: close + delimiter.length, from: chars.length };
        add(value, i, close + delimiter.length, link);
        node.to = chars.length; containers.push(node);
        i = close + delimiter.length; continue;
      }
      const bareUrl = /^https?:\/\/[^\s<>]+/i.exec(text.slice(i, end));
      if (bareUrl) {
        add(bareUrl[0], i, i + bareUrl[0].length, link, false); i += bareUrl[0].length; continue;
      }
      if ((c === "*" || c === "_" || text.startsWith("~~", i))
        && !(c === "_" && /[\p{L}\p{N}]/u.test(text[i - 1] ?? "") && /[\p{L}\p{N}]/u.test(text[i + 1] ?? ""))
        && !(/^\s*\* $/.test(text.slice(text.lastIndexOf("\n", i - 1) + 1, i + 2)))) {
        const delimiter = text.startsWith(c + c, i) ? c + c : c;
        const close = closing(delimiter, i + delimiter.length, end);
        if (/\s/.test(text[i + delimiter.length] ?? "") || /\s/.test(text[close - 1] ?? "")) throw new Error("Ambiguous emphasis");
        const node = { kind: "format", start: i, end: close + delimiter.length, from: chars.length };
        parse(i + delimiter.length, close, link); node.to = chars.length; containers.push(node);
        i = close + delimiter.length; continue;
      }
      if (c === "&") {
        const entity = /^&(#\d+|#x[\da-f]+|[a-z]+);/i.exec(text.slice(i, end));
        if (entity) {
          const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
          const value = entity[1][0] === "#"
            ? String.fromCodePoint(parseInt(entity[1].slice(entity[1][1].toLowerCase() === "x" ? 2 : 1), entity[1][1].toLowerCase() === "x" ? 16 : 10))
            : named[entity[1]];
          if (!value) throw new Error("Unsupported HTML entity");
          add(value, i, i + entity[0].length, link); i += entity[0].length; continue;
        }
      }
      // Heading/blockquote/list prefixes are presentation syntax, never a project mention.
      const prefix = /^(?:#{1,6} |>[ ]?|[-+] |\d+[.)] )/.exec(text.slice(i, end));
      if ((i === 0 || text[i - 1] === "\n") && prefix) { i += prefix[0].length; continue; }
      add(c, i, i + 1, link); i++;
    }
  }
  try { parse(0, text.length); } catch (error) { return fail(error.message); }
  const visible = chars.map(({ c }) => c).join("");
  const word = (c) => /[\p{L}\p{M}\p{N}_]/u.test(c ?? "");
  let from = -1;
  while ((from = visible.indexOf(selection, from + 1)) !== -1) {
    const to = from + selection.length;
    if (!chars.slice(from, to).every((c) => c.selectable)) continue;
    if ((word(Array.from(selection)[0]) && word(Array.from(visible.slice(0, from)).at(-1)))
      || (word(Array.from(selection).at(-1)) && word(Array.from(visible.slice(to))[0]))) continue;
    if (containers.some((node) => node.kind === "code" && node.to > from && node.from < to
      && (node.from < from || node.to > to))) return fail("Selected mention occupies only part of inline code");
    const links = new Set(chars.slice(from, to).map((c) => c.link).filter(Boolean));
    if (links.size) {
      const node = [...links][0];
      if (links.size !== 1 || node.from !== from || node.to !== to) return fail("Selected mention overlaps a link label");
      const comparable = (url) => encodeDestination(url.replace(/\\([\\()[\]])/g, "$1"))
        .replace(/^(https?):\/\/([^/?#]+)(.*)$/i, (_, scheme, host, suffix) => {
          scheme = scheme.toLowerCase();
          host = host.toLowerCase().replace(scheme === "https" ? /:443$/ : /:80$/, "");
          return scheme + "://" + host + (suffix.startsWith("/") ? suffix : "/" + suffix);
        }).replace(/%[\da-f]{2}/gi, (v) => v.toUpperCase());
      try {
        if (comparable(node.url) === comparable(destination)) return { text, ok: true, project_link_text: selection, issue: null };
      } catch { return fail("Unencodable existing destination"); }
      return { text: text.slice(0, node.destinationStart) + destination + text.slice(node.destinationEnd),
        ok: true, project_link_text: selection, issue: null };
    }
    let start = chars[from].start, end = chars[to - 1].end;
    for (const node of containers) {
      if (node.kind !== "format" || node.to <= from || node.from >= to) continue;
      if (node.from >= from && node.to <= to) { start = Math.min(start, node.start); end = Math.max(end, node.end); }
      else if (!(node.from <= from && node.to >= to)) return fail("Selected mention crosses formatting boundaries");
    }
    // Keep supported formatting/escapes, escape only literal brackets in the new label.
    const escapeLabel = (value) => value
      .replace(/\\[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]|\\/g, (s) => s.length === 1 ? "\\\\" : s)
      .replace(/(?<!\\)(?:\\\\)*[\[\]]/g, (s) => s.slice(0, -1) + "\\" + s.at(-1));
    let label = "", cursor = start;
    for (const node of containers.filter((node) => node.kind === "code" && node.start >= start && node.end <= end).sort((a, b) => a.start - b.start)) {
      label += escapeLabel(text.slice(cursor, node.start)) + text.slice(node.start, node.end);
      cursor = node.end;
    }
    label += escapeLabel(text.slice(cursor, end));
    let prefix = text.slice(0, start);
    // A literal ! or lone backslash immediately before a new [ would otherwise
    // turn the wrapper into an image or escape its opening bracket.
    if (text[start - 1] === "!" && !escaped(start - 1)) prefix = prefix.slice(0, -1) + "\\!";
    else if (escaped(start)) prefix += "\\";
    return { text: prefix + "[" + label + "](" + destination + ")" + text.slice(end),
      ok: true, project_link_text: selection, issue: null };
  }
  return fail("Selected project mention is absent from visible text");
}
