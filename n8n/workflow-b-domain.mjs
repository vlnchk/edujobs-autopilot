/**
 * Workflow B M1: pure domain helpers. No Sheet column mapping or runtime I/O.
 *
 * Input rows are latest application values plus explicitly mapped domain facts:
 *   successfully_published: boolean
 *   active_unfinished_batch_id: null | nonblank string
 *   details_link: full unchanged Original Link URL (O-005; mapped by the adapter)
 *   contact: presentation string mapped from the existing upstream contact field
 * These are an in-memory contract, NOT proposed additional Sheet columns.
 * Machine status/reason and final_description are intentionally never consulted.
 */
import { visibleLength } from "../workflow-logic/publication-shape.mjs";
import { submittedLinkUrlCandidate, RESERVED_TELEGRAM_PATHS } from "../workflow-logic/deterministic.mjs";

export const HUMAN_DECISION = Object.freeze({ UNRESOLVED: "", PUBLISH: "PUBLISH", REJECT: "REJECT" });
export const BATCH_STATE = Object.freeze({
  CREATED: "CREATED", PUBLISHING: "PUBLISHING", COMPLETED: "COMPLETED",
  FAILED: "FAILED",
});
export const ITEM_STATE = Object.freeze({ NOT_SENT: "NOT_SENT", SENT: "SENT" });
export const SELECTION = Object.freeze({
  ELIGIBLE: "eligible", UNRESOLVED: "unresolved", REJECTED: "rejected",
  ALREADY_PUBLISHED: "already_published", CLAIMED: "claimed",
});
export const START_MARKER = "...start >>";
export const END_MARKER = "...end >>";
export const DEFAULT_CONFIG = Object.freeze({ MAX_PUBLICATION_DESCRIPTION_CHARS: 900 });

export function validateBatchState(value) {
  if (!Object.values(BATCH_STATE).includes(value)) throw new TypeError("INVALID_BATCH_STATE");
  return value;
}

export function validateItemState(value) {
  if (!Object.values(ITEM_STATE).includes(value)) throw new TypeError("INVALID_ITEM_STATE");
  return value;
}

export function parseHumanDecision(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return HUMAN_DECISION.UNRESOLVED;
  if (value === HUMAN_DECISION.PUBLISH || value === HUMAN_DECISION.REJECT) return value;
  throw new TypeError("INVALID_HUMAN_DECISION");
}

// Decimal numeric sort keys, including gaps/fractions/negative values. No repair,
// positivity rule, integer-only rule, locale parsing, or coercion of booleans.
export function parsePublicationOrder(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) {
    throw new TypeError("MISSING_PUBLICATION_ORDER");
  }
  const numeric = typeof value === "number" ? value
    : typeof value === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())
      ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) throw new TypeError("INVALID_PUBLICATION_ORDER");
  return numeric;
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim().length > 0
  && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value);

function issue(row, sourceIndex, field, code, extra = {}) {
  return {
    source_index: sourceIndex,
    application_id: typeof row?.application_id === "string" ? row.application_id : null,
    row_number: Number.isSafeInteger(row?.row_number) ? row.row_number : null,
    field, code, ...extra,
  };
}

/** Reject unknown publication facts rather than assuming an unclaimed/unsent row. */
export function classifyRow(row, sourceIndex = 0) {
  if (!isRecord(row)) return { ok: false, errors: [issue(null, sourceIndex, "row", "INVALID_ROW")] };
  let decision;
  try { decision = parseHumanDecision(row.human_decision); }
  catch { return { ok: false, errors: [issue(row, sourceIndex, "human_decision", "INVALID_HUMAN_DECISION")] }; }
  if (decision === HUMAN_DECISION.UNRESOLVED) return { ok: true, classification: SELECTION.UNRESOLVED };
  if (decision === HUMAN_DECISION.REJECT) return { ok: true, classification: SELECTION.REJECTED };
  const errors = [];
  if (typeof row.successfully_published !== "boolean") {
    errors.push(issue(row, sourceIndex, "successfully_published", "INVALID_PUBLICATION_FACT"));
  }
  if (row.active_unfinished_batch_id !== null && !isText(row.active_unfinished_batch_id)) {
    errors.push(issue(row, sourceIndex, "active_unfinished_batch_id", "INVALID_CLAIM_FACT"));
  }
  if (errors.length) return { ok: false, errors };
  if (row.successfully_published) return { ok: true, classification: SELECTION.ALREADY_PUBLISHED };
  if (row.active_unfinished_batch_id !== null) return { ok: true, classification: SELECTION.CLAIMED };
  return { ok: true, classification: SELECTION.ELIGIBLE };
}

/** All approved, unpublished, unclaimed rows remain candidates, even if invalid. */
export function selectNewBatch(rows) {
  if (!Array.isArray(rows)) return { ok: false, errors: [issue(null, null, "rows", "INVALID_ROWS")] };
  const result = { ok: true, eligible: [], unresolved: [], rejected: [], already_published: [], claimed: [], errors: [] };
  for (const [index, row] of rows.entries()) {
    const classification = classifyRow(row, index);
    if (!classification.ok) result.errors.push(...classification.errors);
    else result[classification.classification].push(row);
  }
  result.ok = result.errors.length === 0;
  return result;
}

/** O-005: derive display text on every call; never serialize/normalize the URL. */
export function detailsLink(originalLink) {
  if (!isText(originalLink) || !/^https?:\/\/(?:[^/?#\s[\]@]+|\[[0-9a-f:.]+\](?::[0-9]+)?)(?:[/?#]|$)/i.test(originalLink)
    || /[\s\\<>]/u.test(originalLink)) throw new TypeError("INVALID_DETAILS_LINK");
  return {
    href: originalLink,
    text: originalLink.replace(/^https?:\/\//i, "").split(/[?#]/u, 1)[0],
  };
}

/** Markdown presentation only; transport and parse mode remain O-006. */
export function renderDetailsLink(originalLink) {
  const { href, text } = detailsLink(originalLink);
  // Syntax escaping preserves visible characters and the decoded destination.
  const label = text.replace(/[\\`*_[\]<>~&]/g, "\\$&");
  const destination = href.replace(/[\\()&]/g, "\\$&");
  return `[${label}](${destination})`;
}


// Version belongs to frozen content, independent of deployment version labels.
export const PROJECT_LINK_SNAPSHOT_VERSION = 'project-links-v1';
export const PROJECT_LINK_FIELDS = Object.freeze([
  'snapshot_version', 'publication_description', 'project_link_text', 'project_link',
]);
export const PRESENTATION_V1_SNAPSHOT_VERSION = 'presentation-v1';
export const PRESENTATION_V2_SNAPSHOT_VERSION = 'presentation-v2';
export const PRESENTATION_V3_SNAPSHOT_VERSION = 'presentation-v3';
export const PRESENTATION_V4_SNAPSHOT_VERSION = 'presentation-v4';
export const PRESENTATION_SNAPSHOT_VERSION = 'presentation-v5';
const isPresentationFormat = format => [PRESENTATION_V1_SNAPSHOT_VERSION, PRESENTATION_V2_SNAPSHOT_VERSION, PRESENTATION_V3_SNAPSHOT_VERSION,
  PRESENTATION_V4_SNAPSHOT_VERSION, PRESENTATION_SNAPSHOT_VERSION].includes(format);
export const PRESENTATION_FIELDS = Object.freeze([...PROJECT_LINK_FIELDS, 'publication_contact']);

/** Shared O-006 structural policy; no URL global or network dependency. */
export function transportLink(value) {
  const link = detailsLink(value);
  const authority = /^https?:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (!authority || !/^(?:[\p{L}\p{N}](?:[\p{L}\p{N}.-]*[\p{L}\p{N}])?|\[[0-9a-f:]+\])(?::[0-9]{1,5})?$/iu.test(authority)
    || authority.includes('..') || /%(?![0-9a-f]{2})/i.test(value)) throw new TypeError('INVALID_DETAILS_LINK');
  const port = /:(\d+)$/.exec(authority)?.[1];
  if (port && (Number(port) < 1 || Number(port) > 65535)) throw new TypeError('INVALID_DETAILS_LINK');
  return link;
}
export function escapeHtml(value) {
  if (typeof value !== 'string' || !value.isWellFormed()
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) throw new TypeError('INVALID_TELEGRAM_TEXT');
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const linkSyntaxError = () => { throw new TypeError('AMBIGUOUS_PROJECT_LINK_FORMATTING'); };
const presentationEscape = c => c !== undefined && '\\[]()&!'.includes(c);
const escapedAt = (source, index) => {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && source[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
};
const escapeDestination = value => value.replace(/[\\()&]/g, '\\$&');

/**
 * Explicit inline grammar: unescaped brackets are link delimiters. Labels
 * cannot nest or span lines. Destinations have balanced or escaped parentheses.
 * Only backslash, brackets, parentheses, ampersand and exclamation escapes are
 * decoded; all other text stays literal, including HTML and other Markdown.
 * Raw boundaries are transient parser data; never persist offsets.
 */
export function parseInlineLinks(source) {
  escapeHtml(source);
  const spans = [];
  let i = 0;
  const readText = label => {
    const start = i, boundaries = [i]; let text = '';
    while (i < source.length) {
      const c = source[i];
      if (c === '\\' && presentationEscape(source[i + 1])) { text += source[i + 1]; i += 2; }
      else {
        if (c === '[' || c === ']') break;
        if (label && /[\r\n]/.test(c)) linkSyntaxError();
        text += c; i++;
      }
      boundaries.push(i);
    }
    return { start, end: i, text, boundaries };
  };
  while (i < source.length) {
    if (source[i] === ']') linkSyntaxError();
    if (source[i] !== '[') { spans.push({ kind: 'text', ...readText(false) }); continue; }
    if (source[i - 1] === '!' && !escapedAt(source, i - 1)) linkSyntaxError();
    const start = i++;
    const label = readText(true);
    if (!isText(label.text) || source[i] !== ']' || source[i + 1] !== '(') linkSyntaxError();
    i += 2;
    const destinationStart = i;
    let href = '', depth = 0;
    while (i < source.length) {
      const c = source[i];
      if (c === '\\' && presentationEscape(source[i + 1])) { href += source[i + 1]; i += 2; continue; }
      if (c === '(') depth++;
      if (c === ')') { if (depth === 0) break; depth--; }
      href += c; i++;
    }
    if (source[i] !== ')' || depth !== 0) linkSyntaxError();
    try { transportLink(href); } catch { linkSyntaxError(); }
    spans.push({ kind: 'link', start, end: i + 1, text: label.text, href,
      destinationStart, destinationEnd: i });
    i++;
  }
  let position = 0;
  for (const span of spans) { span.visibleStart = position; position += span.text.length; span.visibleEnd = position; }
  return { spans, visible: spans.map(span => span.text).join('') };
}
const wordCharacter = c => c !== undefined && /[\p{L}\p{N}\p{M}_]/u.test(c);
export function locateProjectName(parsed, selection) {
  if (!isText(selection) || !selection.isWellFormed()) throw new TypeError('MISSING_PROJECT_LINK_TEXT');
  const first = Array.from(selection)[0], last = Array.from(selection).at(-1);
  let start = parsed.visible.indexOf(selection);
  while (start !== -1) {
    const end = start + selection.length;
    // Inspect at most one adjacent code point, avoiding quadratic scans on
    // long drafts containing many partial-word collisions.
    const before = Array.from(parsed.visible.slice(Math.max(0, start - 2), start)).at(-1);
    const after = Array.from(parsed.visible.slice(end, end + 2))[0];
    if (!(wordCharacter(first) && wordCharacter(before)) && !(wordCharacter(last) && wordCharacter(after))) {
      const span = parsed.spans.find(s => start >= s.visibleStart && end <= s.visibleEnd);
      if (!span || span.kind === 'link' && (start !== span.visibleStart || end !== span.visibleEnd)) linkSyntaxError();
      return { span, start, end };
    }
    start = parsed.visible.indexOf(selection, start + 1);
  }
  throw new TypeError('PROJECT_LINK_TEXT_NOT_FOUND');
}
export function renderProjectBody(draft, selection, destination) {
  if (!isText(draft)) throw new TypeError('INVALID_DRAFT_DESCRIPTION');
  try { transportLink(destination); escapeHtml(destination); }
  catch { throw new TypeError('INVALID_PROJECT_LINK'); }
  if (!isText(selection)) throw new TypeError('MISSING_PROJECT_LINK_TEXT');
  const parsed = parseInlineLinks(draft);
  const { span, start, end } = locateProjectName(parsed, selection);
  let body;
  if (span.kind === 'link') {
    body = span.href === destination ? draft
      : draft.slice(0, span.destinationStart) + escapeDestination(destination) + draft.slice(span.destinationEnd);
  } else {
    const rawStart = span.boundaries[start - span.visibleStart], rawEnd = span.boundaries[end - span.visibleStart];
    let prefix = draft.slice(0, rawStart), label = draft.slice(rawStart, rawEnd);
    // Wrappers must not turn a preceding literal bang into image syntax or a
    // literal trailing backslash into an escape of the new bracket delimiter.
    if (escapedAt(prefix, prefix.length)) prefix += '\\';
    if (prefix.endsWith('!') && !escapedAt(prefix, prefix.length - 1)) prefix = prefix.slice(0, -1) + '\\!';
    if (escapedAt(label, label.length)) label += '\\';
    body = prefix + '[' + label + '](' + escapeDestination(destination) + ')' + draft.slice(rawEnd);
  }
  const rendered = parseInlineLinks(body), selected = locateProjectName(rendered, selection);
  if (rendered.visible !== parsed.visible || selected.span.kind !== 'link' || selected.span.href !== destination) linkSyntaxError();
  return body;
}
/**
 * O-009 presentation only, after the existing inline-link parser. Links cannot
 * span lines, so a raw line prefix is never inside a label or destination.
 * A bullet is explicit; other markers need a colon heading or a sibling run
 * containing * / •. Unheaded dash-only prose, numeric operands and separators
 * stay literal. Change only marker + following horizontal space.
 */
export function formatUnorderedLists(source) {
  const parts = source.split(/(\r\n|\n|\r)/);
  const lines = parts.filter((_, i) => i % 2 === 0);
  const candidates = lines.map(line => {
    const match = /^([ \t]*)([*–—•-])[ \t]+(\S.*)$/u.exec(line);
    if (!match || /^[*–—•\s-]+$/u.test(match[3])
      || match[2] !== '•' && /^[+\-−]?\p{N}/u.test(match[3])) return null;
    return { indent: match[1], marker: match[2], body: match[3] };
  });
  const normalized = new Set(), visited = new Set();
  for (let i = 0; i < lines.length; i++) {
    const item = candidates[i];
    if (!item) continue;
    if (item.marker === '•') normalized.add(i);
    if (visited.has(i)) continue;
    const siblings = [];
    for (let j = i; j < lines.length; j++) {
      if (!lines[j].trim()) break;
      if (candidates[j]?.indent === item.indent) { siblings.push(j); visited.add(j); }
      else if (!lines[j].startsWith(item.indent) || !/^[ \t]/.test(lines[j].slice(item.indent.length))) break;
    }
    const heading = lines[i - 1];
    const headingIndent = heading?.match(/^[ \t]*/)[0];
    const introduced = heading?.trimEnd().endsWith(':') && item.indent.startsWith(headingIndent);
    if (introduced || siblings.length >= 2 && siblings.some(j => /[*•]/u.test(candidates[j].marker)))
      for (const j of siblings) normalized.add(j);
  }
  for (const i of normalized) parts[i * 2] = candidates[i].indent + '• ' + candidates[i].body;
  return parts.join('');
}

// Recognition changes presentation, never contact eligibility. Unknown pieces
// keep their original text. Labels are preserved, never inferred from a phone.
function contactComponent(part, extended = false, version = 3) {
  const text = part.trim();
  const label = (extended
    ? /^(WhatsApp|Telegram|E-?mail|Phone|Телефон|Почта|Телеграм|ТГ)(?:[\p{Zs}\t]*:[\p{Zs}\t]*|[\p{Zs}\t]+)(.+)$/iu
    : /^(WhatsApp|Telegram|E-?mail|Phone|Телефон|Почта|Телеграм)(?:[ \t]*:[ \t]*|[ \t]+)(.+)$/iu).exec(text);
  const service = label?.[1].toLowerCase(), payload = label ? label[2] : text;
  const phone = value => (extended ? /^\+?\d(?:[\d\p{Zs}\t()-]*\d)?$/u : /^\+?\d(?:[\d ()-]*\d)?$/u).test(value);
  const email = value => /^[^\s@<>()[\],;|\\"]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value);
  const url = value => { try { transportLink(value); return true; } catch { return false; } };
  // O-010 (presentation-v4): an exact Telegram account URL is shown as @username.
  const account = value => {
    const match = version >= 4 && /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/([a-z][a-z0-9_]{4,31})\/?$/i.exec(value);
    return match && !RESERVED_TELEGRAM_PATHS.has(match[1].toLowerCase()) ? '@' + match[1] : null;
  };
  const core = value => {
    const username = value.replace(/\\_/g, '_');
    const telegram = /^@[a-z][a-z0-9_]{4,31}$/i.test(username);
    const address = extended ? value.replace(/\\@/g, '@') : value;
    if (service === 'telegram' || service === 'телеграм' || extended && service === 'тг') return telegram ? username : account(value) ?? (url(value) ? value : null);
    if (service === 'whatsapp' || service === 'phone' || service === 'телефон') return phone(value) || url(value) ? value : null;
    if (service === 'email' || service === 'e-mail' || service === 'почта') return email(address) ? address : url(value) ? value : null;
    return telegram ? username : email(address) ? address : account(value) ?? (phone(value) || url(value) ? value : null);
  };
  let rendered = core(payload);
  if (rendered === null) {
    // Explicit accompanying note; do not swallow another delimited component.
    const note = (extended
      ? /^(.*?)([\p{Zs}\t]+(?:\([^()\r\n|;]*\)|[–—][\p{Zs}\t]+[^|;,\r\n]+))$/u
      : /^(.*?)([ \t]+(?:\([^()\r\n|;]*\)|[–—][ \t]+[^|;,\r\n]+))$/u).exec(payload);
    const main = note && core(note[1]);
    if (main !== null && main !== undefined) rendered = main + note[2];
  }
  if (rendered === null && extended) {
    // Preserve a trailing plain-text note after an exact contact token;
    // no name inference, no removal of its text, and no embedded contact syntax.
    const note = /^(\S+)([\p{Zs}\t]+[\p{L}\p{M}]+(?:[\p{Zs}\t]+[\p{L}\p{M}]+)*)$/u.exec(payload);
    const main = note && core(note[1]);
    if (main !== null && main !== undefined) rendered = main + note[2];
  }
  if (rendered === null) return null;
  // O-010 (presentation-v5): @ already says Telegram and an address says email.
  const redundant = version >= 5 && label && (['telegram', 'телеграм', 'тг'].includes(service) && rendered.startsWith('@')
    || ['email', 'e-mail', 'почта'].includes(service) && /^[^\s@]+@[^\s@]+/.test(rendered));
  return (label && !redundant ? label[1] + ' ' : '') + rendered;
}
function formatContactV1(source) {
  if (!isText(source)) throw new TypeError('INVALID_CONTACT');
  let body = source;
  // Strip only leading copies of the renderer's own wrapper.
  while (/^\s*Контакт:[ \t]*/iu.test(body)) body = body.replace(/^\s*Контакт:[ \t]*/iu, '');
  if (!isText(body)) throw new TypeError('INVALID_CONTACT');
  const single = contactComponent(body);
  if (single !== null) return single;
  const components = body.split(/[ \t]*(?:\r\n|\r|\n|\||;[ \t]+|,[ \t]+)[ \t]*/u).map(part => contactComponent(part));
  return components.length > 1 && components.every(value => value !== null) ? components.join(' | ') : body;
}

// v1 remains frozen: a retry must still accept and send its original contact.
function formatContactV2(source) {
  const body = formatContactV1(source);
  // An explicit service label plus colon establishes a boundary even when the
  // source uses spaces only. Require every resulting component to be known.
  // Try each existing-delimiter piece separately so mixed separators work too.
  if (contactComponent(body) !== null) return body;
  const components = body.split(/[ \t]*(?:\r\n|\r|\n|\||;[ \t]+|,[ \t]+)[ \t]*/u)
    .flatMap(part => contactComponent(part) !== null ? [part]
      : part.split(/[ \t]+(?=(?:WhatsApp|Telegram|E-?mail|Phone|Телефон|Почта|Телеграм)[ \t]*:)/iu))
    .map(part => contactComponent(part));
  return components.length > 1 && components.every(value => value !== null) ? components.join(' | ') : body;
}

// v3 and v4 remain frozen: a retry must still accept and send its original contact.
function formatContactV3(source) {
  return presentationContact(source, 3);
}

// Exported for frozen-format regression tests; new snapshots use formatContact.
export function formatContactV4(source) {
  return presentationContact(source, 4);
}

export function formatContact(source) {
  return presentationContact(source, 5);
}

const CONTACT_LABEL_TOKEN = /^(?:WhatsApp|Telegram|E-?mail|Phone|Телефон|Почта|Телеграм|ТГ):?$/iu;

// O-010 (presentation-v5): split on whitespace around anchors (a username,
// email or URL token). A label token joins the token after it; other tokens
// are rejoined with their original spacing, so phone numbers stay whole.
function anchorPieces(part, component) {
  const tokens = part.split(/([\p{Zs}\t]+)/u);
  const anchor = word => component(word) !== null && !/^\+?[\d()-]+$/u.test(word) && !CONTACT_LABEL_TOKEN.test(word);
  const pieces = [];
  let current = [];
  const flush = words => { if (words.length) pieces.push(words.map((w, i) => (i ? w.sep : '') + w.word).join('')); };
  for (let i = 0; i < tokens.length; i += 2) {
    const word = { word: tokens[i], sep: tokens[i - 1] ?? '' };
    if (!word.word) continue;
    if (!anchor(word.word)) { current.push(word); continue; }
    const last = current.at(-1);
    if (last && CONTACT_LABEL_TOKEN.test(last.word)) {
      flush(current.slice(0, -1));
      pieces.push(last.word + word.sep + word.word);
    } else {
      flush(current);
      pieces.push(word.word);
    }
    current = [];
  }
  flush(current);
  return pieces.length > 1 && pieces.every(piece => component(piece) !== null) ? pieces : [part];
}

// v4 splits every unrecognized piece and lets the final check reject it; v5
// keeps a piece whole unless every slash piece is recognized, so a URL inside
// a whitespace-separated contact list survives for anchorPieces.
function slashPieces(part, component, version) {
  const pieces = part.split('/');
  return version < 5 || pieces.every(piece => component(piece) !== null) ? pieces : [part];
}

function presentationContact(source, version) {
  if (!isText(source)) throw new TypeError('INVALID_CONTACT');
  let body = source;
  while (/^\s*Контакт:[\p{Zs}\t]*/iu.test(body)) body = body.replace(/^\s*Контакт:[\p{Zs}\t]*/iu, '');
  if (!isText(body)) throw new TypeError('INVALID_CONTACT');
  const component = part => contactComponent(part, true, version);
  const single = component(body);
  if (single !== null) return single;
  const components = body.split(/[\p{Zs}\t]*(?:\r\n|\r|\n|\||;[\p{Zs}\t]+|,[\p{Zs}\t]+|[\p{Zs}\t]+\/[\p{Zs}\t]+)[\p{Zs}\t]*/u)
    .flatMap(part => component(part) !== null ? [part]
      : part.split(/[\p{Zs}\t]+(?=(?:WhatsApp|Telegram|E-?mail|Phone|Телефон|Почта|Телеграм|ТГ)[\p{Zs}\t]*:)/iu))
    // O-010: an unspaced slash separates pieces only if every piece is recognized.
    .flatMap(part => version < 4 || component(part) !== null ? [part] : slashPieces(part, component, version))
    .flatMap(part => version < 5 || component(part) !== null ? [part] : anchorPieces(part, component))
    .map(component);
  return components.length > 1 && components.every(value => value !== null) ? components.join(' | ') : body;
}

export function snapshotFormat(item) {
  const absent = f => item[f] === '' || item[f] === null || item[f] === undefined;
  if (isPresentationFormat(item.snapshot_version)) return item.snapshot_version;
  if (item.snapshot_version === PROJECT_LINK_SNAPSHOT_VERSION && absent('publication_contact')) return PROJECT_LINK_SNAPSHOT_VERSION;
  if (PRESENTATION_FIELDS.every(absent)) return 'legacy';
  throw new TypeError('UNSUPPORTED_SNAPSHOT_FORMAT');
}
const bodyWithoutBoundaryLines = body => body.replace(/^(?:[ \t]*\r?\n)+|(?:\r?\n[ \t]*)+$/g, '');

/** Complete frozen vacancy transport, also checked before new persistence. */
export function frozenVacancyTransport(item) {
  const link = transportLink(item.details_link);
  if (!matchesFrozenVacancy(item) || renderVacancy(item) !== item.rendered_text) throw new TypeError('UNSUPPORTED_FROZEN_TRANSPORT_FORMAT');
  let html, visible;
  const format = snapshotFormat(item);
  if (format !== 'legacy') {
    const parsed = parseInlineLinks(bodyWithoutBoundaryLines(item.publication_description));
    html = parsed.spans.map(s => s.kind === 'link'
      ? `<a href="${escapeHtml(s.href)}">${escapeHtml(s.text)}</a>` : escapeHtml(s.text)).join('');
    visible = parsed.visible;
  } else { visible = bodyWithoutBoundaryLines(item.draft_description); html = escapeHtml(visible); }
  const contact = isPresentationFormat(format) ? item.publication_contact : item.contact;
  const prefix = `·${item.batch_position}·\n\n`, suffix = `\n\nКонтакт: ${contact}`;
  return { text: escapeHtml(prefix) + html + '\n\nДетали: '
    + `<a href="${escapeHtml(link.href)}">${escapeHtml(link.text)}</a>` + escapeHtml(suffix),
  visible: prefix + visible + '\n\nДетали: ' + link.text + suffix };
}
export function validateTelegramSize(visible, kind, position = null) {
  if (!visible.length || visible.length > 4096) throw new TypeError(`TELEGRAM_MESSAGE_TOO_LONG:${kind}:${position ?? ''}`);
}

function renderingIssues(row, index, legacy = false) {
  const errors = [];
  for (const field of ["draft_description", "details_link", "contact"]) {
    if (!isText(row[field])) errors.push(issue(row, index, field, `INVALID_${field.toUpperCase()}`, {
      message: field === 'draft_description' ? 'Draft is missing or unusable. Correct draft_description; final_description is never substituted.'
        : `Required publication field ${field} is missing or unusable. Correct its source cell.`,
    }));
    else if (field === "details_link" && !legacy) {
      try { detailsLink(row[field]); }
      catch { errors.push(issue(row, index, field, "INVALID_DETAILS_LINK", {
        message: 'Original Link is missing or invalid. Correct it; Project Link is never substituted for details.',
      })); }
    }
  }
  return errors;
}

function assembleVacancy(row, legacy = false) {
  const { batch_position, draft_description, details_link } = row;
  if (!Number.isSafeInteger(batch_position) || batch_position < 1) throw new TypeError("INVALID_BATCH_POSITION");
  const errors = renderingIssues(row, 0, legacy);
  if (errors.length) throw new TypeError(errors[0].code);
  // Unversioned renderer callers still supply plain domain rows; strict frozen
  // discrimination belongs to matchesFrozenVacancy / snapshotFormat.
  const format = row.snapshot_version;
  const body = bodyWithoutBoundaryLines([PROJECT_LINK_SNAPSHOT_VERSION, PRESENTATION_V1_SNAPSHOT_VERSION, PRESENTATION_V2_SNAPSHOT_VERSION,
    PRESENTATION_V3_SNAPSHOT_VERSION, PRESENTATION_V4_SNAPSHOT_VERSION, PRESENTATION_SNAPSHOT_VERSION].includes(format)
    ? row.publication_description : draft_description);
  const contact = isPresentationFormat(format) ? row.publication_contact : row.contact;
  const details = legacy ? details_link : renderDetailsLink(details_link);
  return `·${batch_position}·\n\n${body}\n\nДетали: ${details}\n\nКонтакт: ${contact}`;
}

/** Always derive the label from the supplied current/frozen full Original Link. */
export function renderVacancy(row) {
  return assembleVacancy(row);
}

/** Read-only compatibility: validate, but never rewrite, pre-O-005 snapshots. */
export function matchesFrozenVacancy(item) {
  const format = snapshotFormat(item);
  if (format !== 'legacy') {
    try {
      let body = renderProjectBody(item.draft_description, item.project_link_text, item.project_link);
      if (isPresentationFormat(format)) {
        body = formatUnorderedLists(body);
        const contactFormatter = format === PRESENTATION_V1_SNAPSHOT_VERSION ? formatContactV1
          : format === PRESENTATION_V2_SNAPSHOT_VERSION ? formatContactV2
          : format === PRESENTATION_V3_SNAPSHOT_VERSION ? formatContactV3
          : format === PRESENTATION_V4_SNAPSHOT_VERSION ? formatContactV4 : formatContact;
        if (contactFormatter(item.contact) !== item.publication_contact) return false;
      }
      return body === item.publication_description && renderVacancy(item) === item.rendered_text;
    }
    catch { return false; }
  }
  try { if (renderVacancy(item) === item.rendered_text) return true; }
  catch { /* A legacy details input may be presentation text rather than a URL. */ }
  try { return assembleVacancy(item, true) === item.rendered_text; }
  catch { return false; }
}

// O-010: read both submitted links through Workflow A's shared representation
// (trim, unwrap a simple Markdown link, add the https scheme to a bare domain). The
// represented values are validated and frozen; Applications cells never change.
function representSubmittedLinks(row) {
  // A view, not a copy: other row fields are read only where they are needed.
  const represent = value => typeof value === 'string' ? submittedLinkUrlCandidate(value) : value;
  return Object.create(row, {
    project_link: { value: represent(row.project_link) },
    details_link: { value: represent(row.details_link) },
  });
}

/**
 * Validate the ENTIRE explicitly selected candidate list. Failures contain only
 * diagnostics, never a partial prepared list. Stable diagnostics follow input order.
 * Config is supplied by the caller; this module never reads the environment.
 */
export function preflightNewBatch(rows, config = DEFAULT_CONFIG) {
  if (!Array.isArray(rows)) return { ok: false, errors: [issue(null, null, "rows", "INVALID_ROWS")] };
  const maximum = config?.MAX_PUBLICATION_DESCRIPTION_CHARS;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    return { ok: false, errors: [issue(null, null, "MAX_PUBLICATION_DESCRIPTION_CHARS", "INVALID_DESCRIPTION_LIMIT")] };
  }
  const errors = [];
  const prepared = [];
  const orders = new Map();
  for (const [index, source] of rows.entries()) {
    if (!isRecord(source)) {
      errors.push(issue(null, index, "row", "INVALID_ROW"));
      continue;
    }
    const row = representSubmittedLinks(source);
    const rowErrors = [];
    const classification = classifyRow(row, index);
    if (!classification.ok) rowErrors.push(...classification.errors);
    else if (classification.classification !== SELECTION.ELIGIBLE) {
      const [field, code] = {
        unresolved: ["human_decision", "NOT_APPROVED"],
        rejected: ["human_decision", "NOT_APPROVED"],
        already_published: ["successfully_published", "ALREADY_PUBLISHED"],
        claimed: ["active_unfinished_batch_id", "CLAIMED_BY_UNFINISHED_BATCH"],
      }[classification.classification];
      rowErrors.push(issue(row, index, field, code));
    }
    if (!isText(row.application_id)) rowErrors.push(issue(row, index, "application_id", "INVALID_APPLICATION_ID"));
    let order;
    try {
      order = parsePublicationOrder(row.publication_order);
      const indices = orders.get(order) ?? [];
      indices.push(index);
      orders.set(order, indices);
    } catch (error) {
      rowErrors.push(issue(row, index, "publication_order", error.message));
    }
    rowErrors.push(...renderingIssues(row, index));
    let publicationDescription, linkedDescriptionLength;
    if (isText(row.draft_description)) {
      try {
        const linked = renderProjectBody(row.draft_description, row.project_link_text, row.project_link);
        linkedDescriptionLength = visibleLength(linked);
        publicationDescription = formatUnorderedLists(linked);
      }
      catch (error) {
        const diagnostics = {
          INVALID_PROJECT_LINK: ['project_link', 'Project Link is missing or invalid. Correct the Project Website Link cell.'],
          MISSING_PROJECT_LINK_TEXT: ['project_link_text', 'Project-name selection is missing. Set project_link_text to the exact visible first project mention.'],
          PROJECT_LINK_TEXT_NOT_FOUND: ['project_link_text', 'Selected project name no longer occurs in the draft. Update project_link_text or the draft.'],
          AMBIGUOUS_PROJECT_LINK_FORMATTING: ['draft_description', 'Project-link formatting is ambiguous. Use plain text or complete inline links; select a complete link label or unlinked text.'],
          INVALID_TELEGRAM_TEXT: ['draft_description', 'Publication text contains unsupported characters. Correct the draft.'],
        };
        const [field, message] = diagnostics[error.message] ?? ['draft_description', error.message];
        rowErrors.push(issue(row, index, field, error.message, { message }));
      }
    }
    if (publicationDescription !== undefined) {
      // Visible length per Workflow A Section 13.0.1 (spec Section 12). Keep the
      // post-link bound too: whitespace cleanup never rescues an over-limit draft.
      const length = Math.max(linkedDescriptionLength, visibleLength(publicationDescription));
      if (length > maximum) rowErrors.push(issue(row, index, "draft_description", "DESCRIPTION_TOO_LONG", {
        actual_chars: length, maximum_chars: maximum,
        message: 'Publication body exceeds the configured limit after updating the project link and list markers. Shorten the draft manually.',
      }));
    }
    let publicationContact;
    if (isText(row.contact)) {
      try { publicationContact = formatContact(row.contact); }
      catch (error) { rowErrors.push(issue(row, index, 'contact', error.message, {
        message: 'Contact Info contains no usable text after its outer label. Correct the source cell.',
      })); }
    }
    errors.push(...rowErrors);
    if (!rowErrors.length) {
      // Explicit primitive copies; never spread a row or retain nested row values.
      prepared.push({
        application_id: row.application_id,
        publication_order: row.publication_order,
        draft_description: row.draft_description,
        snapshot_version: PRESENTATION_SNAPSHOT_VERSION,
        publication_description: publicationDescription,
        project_link_text: row.project_link_text,
        project_link: row.project_link,
        details_link: row.details_link,
        contact: row.contact,
        publication_contact: publicationContact,
        sort_order: order,
      });
    }
  }
  for (const indices of orders.values()) {
    if (indices.length > 1) {
      for (const index of indices) errors.push(issue(rows[index], index, "publication_order", "DUPLICATE_PUBLICATION_ORDER", {
        conflicting_source_indices: [...indices],
      }));
    }
  }
  if (errors.length) {
    errors.sort((a, b) => a.source_index - b.source_index);
    return { ok: false, errors };
  }
  prepared.sort((a, b) => a.sort_order - b.sort_order);
  const items = prepared.map(({ sort_order, ...fields }, index) => {
    const item = { ...fields, batch_position: index + 1 };
    const frozen = Object.freeze({ ...item, rendered_text: renderVacancy(item), state: ITEM_STATE.NOT_SENT });
    try { validateTelegramSize(frozenVacancyTransport(frozen).visible, 'VACANCY', frozen.batch_position); }
    catch (error) {
      const sourceIndex = rows.findIndex(row => row.application_id === item.application_id);
      errors.push(issue(rows[sourceIndex], sourceIndex, 'publication', error.message, {
        message: 'Publication transport is invalid or exceeds the Telegram limit. Correct the body, Original Link or contact.',
      }));
    }
    return frozen;
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, items: Object.freeze(items) };
}

/**
 * Input is the selected latest rows, NOT a filtered successful preflight subset.
 * Identity is supplied (no random IDs/clock). An empty candidate list is a no-op.
 * Initial delivery states are seeds; later delivery attempts must track updates
 * separately from immutable content. This is not the durable Sheet layout (O-004).
 */
export function createBatchSnapshot(rows, { batch_id, config = DEFAULT_CONFIG } = {}) {
  const preflight = preflightNewBatch(rows, config);
  if (!preflight.ok) return preflight;
  if (preflight.items.length === 0) return { ok: true, snapshot: null };
  if (!isText(batch_id)) return { ok: false, errors: [issue(null, null, "batch_id", "INVALID_BATCH_ID")] };
  return {
    ok: true,
    snapshot: Object.freeze({
      batch_id,
      state: BATCH_STATE.CREATED,
      vacancy_count: preflight.items.length,
      start: Object.freeze({ rendered_text: START_MARKER, state: ITEM_STATE.NOT_SENT }),
      items: preflight.items,
      end: Object.freeze({ rendered_text: END_MARKER, state: ITEM_STATE.NOT_SENT }),
    }),
  };
}
