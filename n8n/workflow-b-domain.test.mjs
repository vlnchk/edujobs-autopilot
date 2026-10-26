import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  HUMAN_DECISION, BATCH_STATE, ITEM_STATE, SELECTION, START_MARKER, END_MARKER, DEFAULT_CONFIG,
  validateBatchState, validateItemState, parseHumanDecision, parsePublicationOrder,
  classifyRow, selectNewBatch, renderVacancy, preflightNewBatch, createBatchSnapshot,
  detailsLink, renderDetailsLink, matchesFrozenVacancy, PRESENTATION_FIELDS, renderProjectBody,
} from "./workflow-b-domain.mjs";
import { visibleLength } from "../workflow-logic/publication-shape.mjs";
import { bundledDomain } from "./workflow-b-sheets-fixture.mjs";

const row = (overrides = {}) => ({
  application_id: "application-1", row_number: 2,
  human_decision: "PUBLISH", successfully_published: false, active_unfinished_batch_id: null,
  publication_order: 10, draft_description: "Университет ищет преподавателя.",
  project_link: "https://project.test", project_link_text: "Университет",
  details_link: "https://example.test/job", contact: "@example_contact",
  ...overrides,
});
const snapshot = (rows, options = {}) => createBatchSnapshot(rows, { batch_id: "batch-test", ...options });
function failure(result, code, applicationId = "application-1") {
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === code && error.application_id === applicationId), JSON.stringify(result));
  assert.equal(Object.hasOwn(result, "snapshot"), false);
  assert.equal(Object.hasOwn(result, "items"), false);
}

test("canonical human decisions are exact; blank values remain unresolved", () => {
  assert.deepEqual(Object.values(HUMAN_DECISION), ["", "PUBLISH", "REJECT"]);
  for (const blank of [undefined, null, "", " \t\n"]) assert.equal(parseHumanDecision(blank), "");
  assert.equal(parseHumanDecision("PUBLISH"), "PUBLISH");
  assert.equal(parseHumanDecision("REJECT"), "REJECT");
  for (const invalid of ["publish", " PUBLISH ", "APPROVE", 0, false, {}, []]) {
    assert.throws(() => parseHumanDecision(invalid), /INVALID_HUMAN_DECISION/);
    failure(preflightNewBatch([row({ human_decision: invalid })]), "INVALID_HUMAN_DECISION");
  }
});

test("selection distinguishes all five categories and preserves every eligible candidate", () => {
  const rows = [row(), row({ human_decision: "" }), row({ human_decision: "REJECT" }),
    row({ successfully_published: true }), row({ active_unfinished_batch_id: "unfinished-batch" })];
  const result = selectNewBatch(rows);
  assert.equal(result.ok, true);
  for (const [index, key] of Object.values(SELECTION).entries()) assert.deepEqual(result[key], [rows[index]]);
  assert.deepEqual(result.errors, []);
});

for (const decision of ["", "REJECT"]) {
  test(`${JSON.stringify(decision)} is excluded without requiring publication fields`, () => {
    const candidate = { human_decision: decision };
    const result = selectNewBatch([candidate]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.eligible, []);
    assert.deepEqual(result[decision === "" ? "unresolved" : "rejected"], [candidate]);
    failure(preflightNewBatch([row({ human_decision: decision })]), "NOT_APPROVED");
  });
}

for (const machine_status of [undefined, "READY_FOR_REVIEW", "REJECTED", "ERROR", "FUTURE_UNKNOWN_STATUS"]) {
  test(`PUBLISH is eligible and snapshot-valid with upstream status ${machine_status}`, () => {
    const candidate = row({ machine_status, machine_reason: "Original upstream reason", final_description: "Wrong body" });
    const before = structuredClone(candidate);
    const result = selectNewBatch([candidate]);
    assert.deepEqual(result.eligible, [candidate]);
    assert.equal(snapshot(result.eligible).ok, true);
    assert.deepEqual(candidate, before);
  });
}

test("machine fields and optional role/employer metadata are never read", () => {
  const candidate = row();
  for (const field of ["machine_status", "machine_reason", "status", "reason", "final_description", "role_title", "employer_name"]) {
    Object.defineProperty(candidate, field, { get() { throw new Error(`Must not consult ${field}`); } });
  }
  assert.equal(snapshot(selectNewBatch([candidate]).eligible).ok, true);
});

test("already published and unfinished-batch claims also fail direct preflight", () => {
  failure(snapshot([row({ successfully_published: true })]), "ALREADY_PUBLISHED");
  failure(snapshot([row({ active_unfinished_batch_id: "other-batch" })]), "CLAIMED_BY_UNFINISHED_BATCH");
  // A new batch must not absorb an existing claim even when supplied the same ID.
  failure(snapshot([row({ active_unfinished_batch_id: "batch-test" })]), "CLAIMED_BY_UNFINISHED_BATCH");
});

test("unknown publication/claim facts never default to eligible", () => {
  for (const value of [undefined, null, "false", 0]) {
    const candidate = row({ successfully_published: value });
    assert.equal(selectNewBatch([candidate]).ok, false);
    failure(snapshot([candidate]), "INVALID_PUBLICATION_FACT");
  }
  for (const value of [undefined, "", " ", false, {}]) {
    failure(snapshot([row({ active_unfinished_batch_id: value })]), "INVALID_CLAIM_FACT");
  }
});

test("selection does not silently drop approved rows with invalid content or order", () => {
  const candidates = [row(), row({ application_id: "bad", publication_order: null, draft_description: "" })];
  const result = selectNewBatch(candidates);
  assert.equal(result.ok, true);
  assert.deepEqual(result.eligible, candidates);
  failure(snapshot(result.eligible), "MISSING_PUBLICATION_ORDER", "bad");
});

test("numeric ordering accepts gaps, copies raw order, assigns stable independent positions", () => {
  const rows = [row({ application_id: "fifty", publication_order: "50" }),
    row({ application_id: "ten", publication_order: 10 }), row({ application_id: "twenty", publication_order: "20" })];
  const before = structuredClone(rows);
  const result = snapshot(rows);
  assert.equal(result.ok, true);
  assert.deepEqual(result.snapshot.items.map((item) => item.application_id), ["ten", "twenty", "fifty"]);
  assert.deepEqual(result.snapshot.items.map((item) => item.publication_order), [10, "20", "50"]);
  assert.deepEqual(result.snapshot.items.map((item) => item.batch_position), [1, 2, 3]);
  assert.deepEqual(rows, before);
  assert.deepEqual(snapshot(rows), result);
});

test("finite numeric order does not invent positive/integer-only business constraints", () => {
  const items = snapshot([row({ publication_order: 0 }), row({ publication_order: -2.5 }), row({ publication_order: "1e1" })]).snapshot.items;
  assert.deepEqual(items.map((item) => item.publication_order), [-2.5, 0, "1e1"]);
  assert.equal(parsePublicationOrder(" .25 "), 0.25);
});

test("missing order fails without inference", () => {
  for (const publication_order of [undefined, null, "", " \t"]) {
    failure(snapshot([row({ publication_order })]), "MISSING_PUBLICATION_ORDER");
  }
});

test("invalid order fails without coercion or locale repair", () => {
  for (const publication_order of [NaN, Infinity, -Infinity, {}, [], true, "1,000", "abc", "0x10", "1e999"]) {
    failure(snapshot([row({ publication_order })]), "INVALID_PUBLICATION_ORDER");
  }
});

test("duplicate numeric orders identify every offending application, including string equivalents", () => {
  const result = snapshot([row({ application_id: "first", row_number: 12, publication_order: "010" }),
    row({ application_id: "second", row_number: 20, publication_order: 10 })]);
  failure(result, "DUPLICATE_PUBLICATION_ORDER", "first");
  failure(result, "DUPLICATE_PUBLICATION_ORDER", "second");
  assert.deepEqual(result.errors.map(({ application_id, row_number, source_index, conflicting_source_indices }) =>
    ({ application_id, row_number, source_index, conflicting_source_indices })), [
    { application_id: "first", row_number: 12, source_index: 0, conflicting_source_indices: [0, 1] },
    { application_id: "second", row_number: 20, source_index: 1, conflicting_source_indices: [0, 1] },
  ]);
});

test("preflight collects whole-batch failures deterministically and returns no partial snapshot", () => {
  const rows = [row(), row({ application_id: "bad-order", publication_order: null }),
    row({ application_id: "bad-description", publication_order: 30, draft_description: " " }),
    row({ application_id: "bad-contact", publication_order: 40, contact: null })];
  const result = snapshot(rows);
  failure(result, "MISSING_PUBLICATION_ORDER", "bad-order");
  failure(result, "INVALID_DRAFT_DESCRIPTION", "bad-description");
  failure(result, "INVALID_CONTACT", "bad-contact");
  assert.equal(result.errors.length, 3);
  assert.deepEqual(snapshot(rows), result);
});

test("default configured maximum matches the canonical MVP default", () => {
  assert.deepEqual(DEFAULT_CONFIG, { MAX_PUBLICATION_DESCRIPTION_CHARS: 900 });
  const prefix = '[я](https://project.test) ';
  const body = prefix + 'я'.repeat(900 - visibleLength(prefix));
  assert.equal(snapshot([row({ draft_description: body, project_link_text: 'я' })]).ok, true);
  failure(snapshot([row({ draft_description: body + 'я', project_link_text: 'я' })]), 'DESCRIPTION_TOO_LONG');
});

for (const maximum of [30, 77, 725]) {
  test(`configurable post-link length ${maximum}: exact limit passes; over-limit fails without truncation`, () => {
    const config = { MAX_PUBLICATION_DESCRIPTION_CHARS: maximum };
    const prefix = '[я](https://project.test) ';
    const body = prefix + 'я'.repeat(maximum - visibleLength(prefix));
    const valid = snapshot([row({ draft_description: body, project_link_text: 'я' })], { config });
    assert.equal(valid.ok, true);
    assert.equal(valid.snapshot.items[0].draft_description, body);
    assert.ok(valid.snapshot.items[0].rendered_text.includes(`\n\n${body}\n\nДетали:`));
    const candidate = row({ draft_description: body + '!', project_link_text: 'я' });
    const before = structuredClone(candidate), invalid = snapshot([candidate], { config });
    failure(invalid, 'DESCRIPTION_TOO_LONG');
    assert.equal(invalid.errors[0].actual_chars, maximum + 1);
    assert.equal(invalid.errors[0].maximum_chars, maximum);
    assert.deepEqual(candidate, before);
  });
}

test("post-link length counts visible code points, not link syntax or URL, before removing boundary blank lines", () => {
  const body = '[😀я](https://project.test)';
  assert.equal(visibleLength(body), 2);
  const config = { MAX_PUBLICATION_DESCRIPTION_CHARS: visibleLength(body) };
  assert.equal(snapshot([row({ draft_description: body, project_link_text: '😀я' })], { config }).ok, true);
  failure(snapshot([row({ draft_description: '\n' + body + '\n', project_link_text: '😀я' })], { config }), 'DESCRIPTION_TOO_LONG');
});

test("invalid configuration fails explicitly without falling back to a default", () => {
  for (const config of [null, {}, { MAX_PUBLICATION_DESCRIPTION_CHARS: "600" },
    ...[0, -1, NaN, Infinity, 1.5].map((value) => ({ MAX_PUBLICATION_DESCRIPTION_CHARS: value }))]) {
    failure(snapshot([row()], { config }), "INVALID_DESCRIPTION_LIMIT", null);
  }
});

for (const field of ["draft_description", "details_link", "contact"]) {
  test(`${field} must be usable text, never coerced or replaced`, () => {
    for (const value of [undefined, null, "", " \n\t", {}, [], 42, "bad\u0000text"]) {
      failure(snapshot([row({ [field]: value })]), `INVALID_${field.toUpperCase()}`);
    }
  });
}

test("domain takes the mapped Original Link URL without consulting source columns", () => {
  const candidate = row({ details_link: undefined, "Project Website Link": "https://example.test/project", "Original Link": "https://example.test/original" });
  failure(snapshot([candidate]), "INVALID_DETAILS_LINK");
  candidate.details_link = "https://example.test/chosen";
  assert.match(snapshot([candidate]).snapshot.items[0].rendered_text, /example\.test\/chosen/);
});

test("renderer emits the exact canonical text, numbering, blank lines and no remote suffix", () => {
  const actual = renderVacancy({ ...row(), batch_position: 2, publication_order: 50, remote: true });
  assert.equal(actual, "·2·\n\nУниверситет ищет преподавателя.\n\nДетали: [example.test/job](https://example.test/job)\n\nКонтакт: @example_contact");
  assert.doesNotMatch(actual, /remote|·50·/);
  assert.equal(renderVacancy({ ...row(), batch_position: 2 }), actual);
});

test("renderer preserves body formatting, content links, indentation and contact formatting", () => {
  const draft_description = "*Название*  \n  _Курс_ [ссылка](https://example.test/course)\n\nВторая строка.";
  const contact = "[Связаться](https://example.test/contact)";
  const result = snapshot([row({ draft_description, contact, project_link_text: "ссылка" })]);
  const item = result.snapshot.items[0];
  assert.equal(item.draft_description, draft_description);
  assert.equal(item.rendered_text, `·1·\n\n${renderProjectBody(draft_description, "ссылка", row().project_link)}\n\nДетали: ${renderDetailsLink(row().details_link)}\n\nКонтакт: ${contact}`);
});

test("boundary blank lines alone are removed for exactly one blank line after numbering", () => {
  const draft_description = "\r\n \r\n  *Body*\n\nSecond line.\r\n\r\n";
  const item = snapshot([row({ draft_description, project_link_text: "Body" })]).snapshot.items[0];
  assert.ok(item.rendered_text.startsWith("·1·\n\n  *[Body](https://project.test)*\n\nSecond line.\n\nДетали:"));
  assert.equal(item.draft_description, draft_description);
});

test("positions 1, 9, 10, 11 use exact middle-dot formatting", () => {
  for (const batch_position of [1, 9, 10, 11]) {
    assert.ok(renderVacancy({ ...row(), batch_position }).startsWith(`·${batch_position}·\n\n`));
  }
  for (const batch_position of [undefined, 0, -1, 1.5, "1", NaN, Infinity]) {
    assert.throws(() => renderVacancy({ ...row(), batch_position }), /INVALID_BATCH_POSITION/);
  }
  assert.throws(() => renderVacancy({ ...row({ contact: null }), batch_position: 1 }), /INVALID_CONTACT/);
});

test("START and END markers and initial snapshot states are exact", () => {
  assert.equal(START_MARKER, "...start >>");
  assert.equal(END_MARKER, "...end >>");
  const value = snapshot([row()]).snapshot;
  assert.equal(value.state, "CREATED");
  assert.equal(value.vacancy_count, 1);
  assert.deepEqual(value.start, { rendered_text: "...start >>", state: "NOT_SENT" });
  assert.deepEqual(value.end, { rendered_text: "...end >>", state: "NOT_SENT" });
  assert.equal(value.items[0].state, "NOT_SENT");
});

test("each independent batch resets numbering and uses latest supplied edits", () => {
  const candidate = row();
  const first = snapshot([candidate, row({ application_id: "second", publication_order: 20 })]).snapshot;
  Object.assign(candidate, { draft_description: "Новый текст", project_link_text: "Новый", details_link: "https://example.test/new", contact: "@new", publication_order: 99 });
  const second = snapshot([candidate], { batch_id: "new-batch" }).snapshot;
  assert.equal(second.items[0].batch_position, 1);
  assert.equal(second.items[0].rendered_text, "·1·\n\n[Новый](https://project.test) текст\n\nДетали: [example.test/new](https://example.test/new)\n\nКонтакт: @new");
  assert.equal(first.items[0].draft_description, row().draft_description);
  assert.equal(first.items[1].batch_position, 2);
});

test("snapshots retain no mutable source publication fields, rows or array references", () => {
  const candidate = row({ extra: { nested: ["original"] } });
  const rows = [candidate];
  const value = snapshot(rows).snapshot;
  const before = structuredClone(value);
  Object.assign(candidate, { application_id: "changed", draft_description: "Edited later", details_link: "changed", contact: "changed", publication_order: 900 });
  candidate.extra.nested.push("mutation");
  rows.push(row());
  rows[0] = null;
  assert.deepEqual(value, before);
  assert.equal(Object.hasOwn(value.items[0], "extra"), false);
  assert.equal(renderVacancy(value.items[0]), before.items[0].rendered_text);
});

test("snapshot object, items, marker records and item array are frozen", () => {
  const value = snapshot([Object.freeze(row())]).snapshot;
  for (const part of [value, value.start, value.end, value.items, ...value.items]) assert.equal(Object.isFrozen(part), true);
  assert.throws(() => { value.items[0].draft_description = "changed"; }, TypeError);
  assert.throws(() => { value.items[0].rendered_text = "changed"; }, TypeError);
  assert.throws(() => { value.items.push({}); }, TypeError);
  assert.throws(() => { value.start.rendered_text = "changed"; }, TypeError);
  assert.throws(() => { value.batch_id = "changed"; }, TypeError);
});

test("frozen content is self-contained across JSON round trips for future persistence adapters", () => {
  const value = snapshot([row()]).snapshot;
  const restored = JSON.parse(JSON.stringify(value));
  assert.deepEqual(restored, value);
  assert.equal(renderVacancy(restored.items[0]), value.items[0].rendered_text);
});

test("empty selection is a no-op and batch identity must be explicitly supplied", () => {
  assert.deepEqual(preflightNewBatch([]), { ok: true, items: [] });
  assert.deepEqual(createBatchSnapshot([]), { ok: true, snapshot: null });
  for (const batch_id of [undefined, null, "", {}, 42]) failure(snapshot([row()], { batch_id }), "INVALID_BATCH_ID", null);
});

test("malformed rows/lists and missing identity return addressable structured errors", () => {
  for (const rows of [undefined, null, {}]) {
    failure(preflightNewBatch(rows), "INVALID_ROWS", null);
    assert.equal(selectNewBatch(rows).ok, false);
  }
  for (const candidate of [undefined, null, [], 42]) {
    failure(snapshot([candidate]), "INVALID_ROW", null);
    assert.equal(classifyRow(candidate).ok, false);
  }
  const result = snapshot([row({ application_id: undefined, row_number: 42 })]);
  failure(result, "INVALID_APPLICATION_ID", null);
  assert.equal(result.errors[0].row_number, 42);
  assert.equal(result.errors[0].source_index, 0);
});

test("canonical batch and item enum values and validation are exact", () => {
  assert.deepEqual(Object.values(BATCH_STATE), ["CREATED", "PUBLISHING", "COMPLETED", "FAILED"]);
  assert.deepEqual(Object.values(ITEM_STATE), ["NOT_SENT", "SENT"]);
  for (const state of Object.values(BATCH_STATE)) assert.equal(validateBatchState(state), state);
  for (const state of Object.values(ITEM_STATE)) assert.equal(validateItemState(state), state);
  for (const invalid of [undefined, null, "", "sent", "DONE", {}, 0]) {
    assert.throws(() => validateBatchState(invalid), /INVALID_BATCH_STATE/);
    assert.throws(() => validateItemState(invalid), /INVALID_ITEM_STATE/);
  }
  assert.throws(() => validateBatchState("UNKNOWN"), /INVALID_BATCH_STATE/);
  assert.throws(() => validateBatchState("NEEDS_VERIFICATION"), /INVALID_BATCH_STATE/);
  assert.throws(() => validateItemState("NEEDS_VERIFICATION"), /INVALID_ITEM_STATE/);
  for (const value of [HUMAN_DECISION, BATCH_STATE, ITEM_STATE, SELECTION, DEFAULT_CONFIG]) assert.equal(Object.isFrozen(value), true);
});

test("domain module depends only on shared Workflow A helpers and has no network/runtime access, LLM functionality or secrets", () => {
  const shared = ['import { visibleLength } from "../workflow-logic/publication-shape.mjs";\n',
    'import { submittedLinkUrlCandidate, RESERVED_TELEGRAM_PATHS } from "../workflow-logic/deterministic.mjs";\n'];
  const full = readFileSync(new URL("./workflow-b-domain.mjs", import.meta.url), "utf8");
  for (const line of shared) assert.equal(full.split(line).length, 2);
  const source = shared.reduce((text, line) => text.replace(line, ""), full);
  assert.doesNotMatch(source, /\bimport\b|\brequire\s*\(|\bfetch\s*\(|\bprocess\b|\bXMLHttpRequest\b|\bWebSocket\b|\bDate\b|Math\.random|\basync\b|\beval\s*\(|new Function/);
  assert.doesNotMatch(source, /openai|anthropic|gemini|langchain|\bllm\b|n8n-nodes|https?:\/\//i);
  assert.doesNotMatch(source, /credentials|api[_-]?key|access[_-]?token|bot[_-]?token|private[_-]?key|password|authorization|-----BEGIN/i);
  assert.equal((source.match(/\b900\b/g) ?? []).length, 1, "default is defined once");
});

test("sparse candidate arrays cannot silently omit an invalid row", () => {
  const rows = [row(), , row({ application_id: "third", publication_order: 30 })];
  failure(snapshot(rows), "INVALID_ROW", null);
  assert.equal(selectNewBatch(rows).ok, false);
  assert.equal(selectNewBatch(rows).errors[0].source_index, 1);
});

test("an invalid decision makes mixed-row selection unsuccessful and addressable", () => {
  const result = selectNewBatch([row(), row({ application_id: "invalid-decision", human_decision: "APPROVE" })]);
  assert.equal(result.ok, false);
  assert.equal(result.eligible.length, 1);
  assert.deepEqual(result.errors, [{
    source_index: 1, application_id: "invalid-decision", row_number: 2,
    field: "human_decision", code: "INVALID_HUMAN_DECISION",
  }]);
});

test('O-005 example keeps the full href and derives the clean label', () => {
  const href = 'https://hh.ru/vacancy/137336583?hhtmFrom=vacancy_search_list';
  assert.deepEqual(detailsLink(href), { href, text: 'hh.ru/vacancy/137336583' });
  assert.equal(renderDetailsLink(href), `[hh.ru/vacancy/137336583](${href})`);
});
for (const [href, text] of [
  ['http://example.test/jobs/42?x=1&x=2&empty=&encoded=%2F+a', 'example.test/jobs/42'],
  ['https://EXAMPLE.test:443/Jobs/%2f/?next=https%3A%2F%2Fa.test#section', 'EXAMPLE.test:443/Jobs/%2f/'],
  ['https://example.test', 'example.test'],
  ['https://example.test/', 'example.test/'],
  ['HTTPS://example.test/Path?', 'example.test/Path'],
  ['https://example.test/a#section?not-a-query', 'example.test/a'],
  ['https://example.test/search%3Fword%23part?x=%252F', 'example.test/search%3Fword%23part'],
  ['https://пример.рф/вакансия?поиск=роль', 'пример.рф/вакансия'],
]) test(`O-005 preserves the exact URL without normalization: ${href}`, () => {
  assert.deepEqual(detailsLink(href), { href, text });
  assert.equal(snapshot([row({ details_link: href })]).snapshot.items[0].details_link, href);
});
test('link syntax escaping preserves literal label characters and query entity text', () => {
  const href = 'https://example.test/a_[b]*(c)&copy;?q=(value)&copy;=yes';
  assert.equal(detailsLink(href).href, href);
  assert.equal(detailsLink(href).text, 'example.test/a_[b]*(c)&copy;');
  assert.equal(renderDetailsLink(href), String.raw`[example.test/a\_\[b\]\*(c)\&copy;](https://example.test/a_[b]*\(c\)\&copy;?q=\(value\)\&copy;=yes)`);
});
test('label is recalculated on every render; separate display-text inputs are ignored', () => {
  const item = { ...row(), batch_position: 1, details_text: 'Stale', display_text: 'Stale' };
  assert.match(renderVacancy(item), /\[example\.test\/job\]/);
  item.details_link = 'https://example.test/new?full=original';
  assert.match(renderVacancy(item), /\[example\.test\/new\]\(https:\/\/example\.test\/new\?full=original\)/);
  assert.doesNotMatch(renderVacancy(item), /Stale/);
  const frozen = snapshot([item]).snapshot.items[0];
  assert.equal('details_text' in frozen, false); assert.equal('display_text' in frozen, false);
});
test('new snapshots reject unusable Original Link values without repair', () => {
  for (const details_link of ['ftp://example.test/job', 'javascript:alert(1)', 'https://', 'https://[invalid',
    'https:///example.test', 'https://example.test/a b', 'https://example.test/<job>', 'https://example.test/\\job',
    '[Vacancy](ftp://example.test/job)', 'example', 'mailto:job@example.test']) {
    failure(snapshot([row({ details_link })]), 'INVALID_DETAILS_LINK');
  }
});
test('O-010: Original Link is read through the shared representation and frozen; the source row is unchanged', () => {
  for (const [details_link, represented] of [['example.test/job', 'https://example.test/job'],
    ['[Vacancy](https://example.test/job)', 'https://example.test/job'], [' https://example.test/job', 'https://example.test/job'],
    ['https://example.test/job\n', 'https://example.test/job'], ['www.example.test/job?x=1', 'https://www.example.test/job?x=1'],
    ['HTTPS://Example.test/Job?x=1#part', 'HTTPS://Example.test/Job?x=1#part']]) {
    const candidate = row({ details_link }), before = structuredClone(candidate), result = snapshot([candidate]);
    assert.equal(result.ok, true, details_link);
    assert.equal(result.snapshot.items[0].details_link, represented);
    assert.deepEqual(candidate, before);
  }
});
test('frozen compatibility accepts both exact formats, never rewriting old content', () => {
  const modern = snapshot([row()]).snapshot.items[0];
  assert.equal(matchesFrozenVacancy(modern), true);
  const legacy = { ...modern, ...Object.fromEntries(PRESENTATION_FIELDS.map(k => [k, ''])), details_link: '[Old title](https://example.test/job?q=original)',
    rendered_text: '·1·\n\nУниверситет ищет преподавателя.\n\nДетали: [Old title](https://example.test/job?q=original)\n\nКонтакт: @example_contact' };
  const before = structuredClone(legacy);
  assert.equal(matchesFrozenVacancy(legacy), true); assert.deepEqual(legacy, before);
  assert.equal(matchesFrozenVacancy({ ...legacy, rendered_text: 'damaged' }), false);
  assert.equal(matchesFrozenVacancy({ ...legacy, batch_position: 0 }), false);
});


test('O-005 runs in a Code-style VM without URL, require, or browser globals', () => {
  const result = runInNewContext(bundledDomain() + '; detailsLink("https://hh.ru/vacancy/137336583?hhtmFrom=vacancy_search_list")');
  assert.equal(result.href, 'https://hh.ru/vacancy/137336583?hhtmFrom=vacancy_search_list');
  assert.equal(result.text, 'hh.ru/vacancy/137336583');
});

test('O-007 rejects durable FAILED and UNKNOWN vacancy states', () => {
  for (const state of ['FAILED', 'UNKNOWN']) assert.throws(() => validateItemState(state), /INVALID_ITEM_STATE/);
});
