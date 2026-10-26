import { credentialEnv } from './workflow-b-credentials-fixture.mjs';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProjectBody, parseInlineLinks, preflightNewBatch, PRESENTATION_FIELDS,
  PRESENTATION_SNAPSHOT_VERSION, renderVacancy, transportLink, frozenVacancyTransport } from './workflow-b-domain.mjs';
import { sheetsConfig, setupPlan, newBatchPlan, persistenceState, readPlan, table, LEGACY_ITEM_FIELDS } from './workflow-b-sheets.mjs';
import { SheetFixture, example, runGraph } from './workflow-b-sheets-fixture.mjs';
import { verifyHyperlinkWorkflow } from './workflow-b-integrated-fixture.mjs';
import { visibleLength } from '../workflow-logic/publication-shape.mjs';

const url = 'https://project.test';
const candidate = change => ({ application_id: 'app-link', row_number: 7, human_decision: 'PUBLISH',
  publication_order: 10, successfully_published: false, active_unfinished_batch_id: null,
  draft_description: 'Project is hiring. Project again.', project_link_text: 'Project', project_link: url,
  details_link: 'https://vacancy.test/a?x=1&x=2', contact: '@editor', ...change });
const prepared = change => preflightNewBatch([candidate(change)]);
const failure = (change, code) => {
  const result = prepared(change);
  assert.equal(result.ok, false); assert.equal(result.items, undefined);
  assert.ok(result.errors.some(e => e.code === code && e.application_id === 'app-link' && e.row_number === 7), JSON.stringify(result));
  return result;
};

for (const [label, draft, expected] of [
  ['already correct', '[Project](https://project.test) hires Project.', '[Project](https://project.test) hires Project.'],
  ['repetition', 'Project hires Project.', '[Project](https://project.test) hires Project.'],
  ['earlier unlinked', 'Project then [Project](https://old.test)', '[Project](https://project.test) then [Project](https://old.test)'],
  ['removed wrapper', 'Project hires.', '[Project](https://project.test) hires.'],
  ['destination refreshed only', '[Project](https://old.test) hires [Other](https://other.test)', '[Project](https://project.test) hires [Other](https://other.test)'],
  ['ignore destination mentions', '[Other](https://example.test/Project) Project', '[Other](https://example.test/Project) [Project](https://project.test)'],
  ['skip partial words', 'Projector _Project Project2 Project.', 'Projector _Project Project2 [Project](https://project.test).'],
]) test(`project body: ${label}`, () => {
  const rendered = renderProjectBody(draft, 'Project', url);
  assert.equal(rendered, expected);
  assert.equal(renderProjectBody(rendered, 'Project', url), rendered, 'idempotent; never nested');
});

test('canonical identity is never a displayed-name fallback', () => {
  const row = candidate({ employer_name: 'Canonical Legal Identity' });
  Object.defineProperty(row, 'employer_name', { get() { throw Error('must not inspect identity'); } });
  assert.equal(preflightNewBatch([row]).ok, true);
  failure({ project_link_text: null, employer_name: 'Project' }, 'MISSING_PROJECT_LINK_TEXT');
  failure({ draft_description: '', final_description: 'Project is hiring.' }, 'INVALID_DRAFT_DESCRIPTION');
});
for (const project_link_text of [undefined, null, '', ' \t', 1, '\ud800'])
  test(`missing or unusable selection ${JSON.stringify(project_link_text)}`, () => failure({ project_link_text }, 'MISSING_PROJECT_LINK_TEXT'));
for (const draft_description of ['Projector', 'project', 'Проект', 'Renamed hiring team', 'Cafe\u0301'])
  test(`exact selection absent: ${draft_description}`, () => failure({ draft_description,
    project_link_text: draft_description === 'Cafe\u0301' ? 'Café' : 'Project' }, 'PROJECT_LINK_TEXT_NOT_FOUND'));
for (const boundary of ['A', 'Ж', '中', '١', '1', '_', '\u0301', '𝒜']) for (const side of ['before', 'after'])
  test(`Unicode word boundary ${side} ${boundary}`, () => {
    const collision = side === 'before' ? boundary + 'Project' : 'Project' + boundary;
    assert.equal(renderProjectBody(collision + ' Project!', 'Project', url), collision + ' [Project](https://project.test)!');
    failure({ draft_description: collision }, 'PROJECT_LINK_TEXT_NOT_FOUND');
  });
test('selection is never trimmed or Unicode-normalized; punctuation boundaries are literal', () => {
  failure({ draft_description: 'A'.repeat(50000), project_link_text: 'A' }, 'PROJECT_LINK_TEXT_NOT_FOUND');
  assert.equal(renderProjectBody(' Team hiring', ' Team', url), '[ Team](https://project.test) hiring');
  failure({ draft_description: 'Team hiring', project_link_text: ' Team' }, 'PROJECT_LINK_TEXT_NOT_FOUND');
  assert.equal(renderProjectBody('a«Проект»b', '«Проект»', url), 'a[«Проект»](https://project.test)b');
  assert.equal(renderProjectBody('😀 Project', '😀', url), '[😀](https://project.test) Project');
});
for (const [draft_description, project_link_text] of [
  ['[Project team](https://old.test) Project', 'Project'],
  ['[The Project](https://old.test) Project', 'Project'],
  ['Project [Team](https://old.test) Project Team', 'Project Team'],
  ['[Project](https://old.test) Team Project Team', 'Project Team'],
  ['[Project](https://old.test)[ Team](https://other.test) Project Team', 'Project Team'],
]) test(`earliest ambiguous occurrence stops instead of skipping: ${draft_description}`, () => {
  const result = failure({ draft_description, project_link_text }, 'AMBIGUOUS_PROJECT_LINK_FORMATTING');
  assert.match(result.errors[0].message, /formatting is ambiguous/);
});

test('presentation escapes preserve brackets, backslashes, parentheses, entities and literal HTML', () => {
  const draft = String.raw`<b>Музей</b> \[A\] \\ (B) &amp; *plain* [Другой](https://other.test/a(b(c))?x=1\&x=2)`;
  const selection = '[A] \\ (B)';
  const result = prepared({ draft_description: draft, project_link_text: selection,
    project_link: 'https://project.test/a(b(c))?x=1&x=2&q="yes"&copy;' });
  assert.equal(result.ok, true);
  const item = result.items[0], transport = frozenVacancyTransport(item);
  assert.equal(item.draft_description, draft);
  assert.ok(item.publication_description.endsWith('[Другой](https://other.test/a(b(c))?x=1\\&x=2)'));
  assert.ok(transport.text.startsWith('·1·\n\n&lt;b&gt;Музей&lt;/b&gt; <a href="https://project.test/a(b(c))?x=1&amp;x=2&amp;q=&quot;yes&quot;&amp;copy;">[A] \\ (B)</a>'));
  assert.ok(transport.text.includes('&amp;amp; *plain* <a href="https://other.test/a(b(c))?x=1&amp;x=2">Другой</a>'));
  assert.equal(parseInlineLinks(item.publication_description).visible, parseInlineLinks(draft).visible);
});
for (const destination of ['https://example.test/a(b(c))?x=1&x=2&empty=#F',
  'HTTPS://EXAMPLE.test:443/a%2f?q=%252F+z&copy;', 'https://пример.рф/работа?x=1',
  'http://[2001:db8::1]:8080/a(b)', 'https://example.test/unbalanced)('])
  test(`exact decoded destination preserved: ${destination}`, () => {
    const body = renderProjectBody('Project', 'Project', destination);
    assert.equal(parseInlineLinks(body).spans[0].href, destination);
    assert.equal(renderProjectBody(body, 'Project', destination), body);
  });
test('already correct balanced destination and presentation spelling remain byte-for-byte unchanged', () => {
  const draft = '[Project](https://project.test/a(b)?x=1\\&x=2) then Project';
  assert.equal(renderProjectBody(draft, 'Project', 'https://project.test/a(b)?x=1&x=2'), draft);
});
for (const project_link of ['', null, 'ftp://project.test',
  'javascript:alert(1)', 'https://u:p@project.test', 'https://project..test', 'https://project.test:0',
  'https://project.test:65536', 'https://project.test/%xx', 'https://project.test/a b',
  'https://project.test/\\x', 'https://project.test/<x>', 'https://', 'https://[invalid]'])
  test(`shared structural URL policy rejects ${JSON.stringify(project_link)}`, () => {
    assert.throws(() => transportLink(project_link));
    const result = failure({ project_link }, 'INVALID_PROJECT_LINK');
    assert.match(result.errors[0].message, /Project Link is missing or invalid/);
  });
for (const suffix of ['[broken', 'broken]', '[label]', '[label][ref]', '![image](https://x.test)',
  '[outer [inner]](https://x.test)', '[x](https://x.test', '[x](https://x.test/a(b)',
  '[x](https://x.test "title")', '[x](<https://x.test>)', '[x](javascript:alert(1))',
  '[x](https://x.test/%xx)', '[x\ny](https://x.test)', '[](https://x.test)'])
  test(`unsupported or malformed link fails without repair: ${suffix}`, () =>
    failure({ draft_description: 'Project ' + suffix }, 'AMBIGUOUS_PROJECT_LINK_FORMATTING'));

test('post-insertion and destination-refresh product limits count visible length, not link syntax or URL', () => {
  for (const draft_description of ['Project 😀', '[Project](https://x.test) 😀']) {
    const row = candidate({ draft_description, project_link: 'https://project.test/' + 'a'.repeat(60) });
    const canonical = renderProjectBody(row.draft_description, row.project_link_text, row.project_link);
    const length = visibleLength(canonical), config = { MAX_PUBLICATION_DESCRIPTION_CHARS: length };
    assert.equal(length, Array.from('Project 😀').length);
    assert.equal(preflightNewBatch([row], config).ok, true);
    const result = preflightNewBatch([row], { MAX_PUBLICATION_DESCRIPTION_CHARS: length - 1 });
    assert.equal(result.ok, false); assert.equal(result.errors[0].actual_chars, length);
    assert.match(result.errors[0].message, /after updating the project link/);
  }
  const tiny = preflightNewBatch([candidate()], { MAX_PUBLICATION_DESCRIPTION_CHARS: 1 });
  assert.equal(tiny.ok, false);
});
test('O-010: Project Link is read through the shared representation, frozen and used as the destination', () => {
  for (const project_link of [' https://project.test', 'https://project.test ', 'project.test', '[Project](https://project.test)']) {
    const row = candidate({ project_link }), before = structuredClone(row), result = preflightNewBatch([row]);
    assert.equal(result.ok, true, project_link);
    assert.equal(result.items[0].project_link, 'https://project.test');
    assert.match(result.items[0].publication_description, /\[Project\]\(https:\/\/project\.test\)/);
    assert.deepEqual(row, before);
  }
  const bare = preflightNewBatch([candidate({ project_link: 'vk.com/exampleschool' })]);
  assert.equal(bare.ok, true); assert.equal(bare.items[0].project_link, 'https://vk.com/exampleschool');
  for (const project_link of ['https//', 'project', 'vk.com exampleschool']) failure({ project_link }, 'INVALID_PROJECT_LINK');
});
test('complete transport limit includes numbering, details, contact and UTF-16 surrogate units', () => {
  const row = candidate(), item = prepared().items[0];
  const overhead = frozenVacancyTransport(item).visible.length - row.contact.length;
  assert.equal(preflightNewBatch([{ ...row, contact: 'x'.repeat(4096 - overhead) }]).ok, true);
  failure({ contact: 'x'.repeat(4097 - overhead) }, 'TELEGRAM_MESSAGE_TOO_LONG:VACANCY:1');
  failure({ contact: '😀'.repeat(2048) }, 'TELEGRAM_MESSAGE_TOO_LONG:VACANCY:1');
});

const directory = mkdtempSync(join(tmpdir(), 'workflow-b-hyperlinks-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const artifact = join(directory, 'workflow.json');
execFileSync(process.execPath, [fileURLToPath(new URL('./build-workflow-b.mjs', import.meta.url)), artifact], { env: credentialEnv });
const workflow = JSON.parse(readFileSync(artifact, 'utf8'));
const env = { GOOGLE_SHEETS_DOCUMENT_ID: 'synthetic-links', WORKFLOW_B_TELEGRAM_CHAT_ID: '-1001234567890', WORKFLOW_B_TELEGRAM_EXPECTED_BOT_ID: '222' };
const c = sheetsConfig(env), now = '2026-09-20T00:00:00Z';
const state = f => persistenceState(c, f.metadata(), f.get(readPlan(c, f.metadata()).url));
function ready(rows = [example()]) {
  const f = new SheetFixture(rows);
  f.commit(setupPlan(c, f.metadata(), f.sheet(c.applications).values).requests);
  rows.forEach((row, i) => { for (const key of ['human_decision', 'publication_order']) f.edit(c.applications, i + 2, key, row[key]); });
  f.control(c, true); f.calls = []; return f;
}
const plan = f => newBatchPlan(c, f.metadata(), state(f), f.sheet(c.applications).values, randomUUID(), now);
const legacy = f => {
  const s = f.sheet(c.items), headers = s.values[0];
  s.values = [LEGACY_ITEM_FIELDS, ...table(s.values).rows.map(row => {
    const item = Object.fromEntries(LEGACY_ITEM_FIELDS.map(k => [k, row[k]]));
    item.rendered_text = renderVacancy(item);
    return LEGACY_ITEM_FIELDS.map(k => item[k]);
  })];
  assert.ok(headers.length > LEGACY_ITEM_FIELDS.length);
};
for (const change of [{ project_link_text: '' }, { 'Project Website Link': '' }, { draft_description: 'Renamed' },
  { draft_description: '[Approved team](https://x.test)' }, { 'Contact Info': 'x'.repeat(4096) },
  { draft_description: 'Approved ' + 'я'.repeat(900) }, { 'Original Link': 'https://example.test/%xx' }])
  test(`generated whole-batch preflight rejects final row before claim/write/START: ${Object.keys(change)}`, async () => {
    const f = ready([example('good', 10), { ...example('bad', 20), ...change }]);
    const before = structuredClone(f.sheets);
    const result = await runGraph(workflow, f, env, undefined, () => { throw Error('must not call Telegram'); });
    assert.equal(result.result.kind, 'PREFLIGHT_FAILED');
    assert.ok(result.result.errors.some(e => e.application_id === 'bad' && e.row_number === 3));
    assert.deepEqual(f.sheets, before); assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
    assert.equal(f.sheet(c.claim), undefined);
  });
for (const mode of ['setup', 'run']) for (const field of ['project_link_text', 'Project Website Link', 'draft_description'])
  test(`missing upstream ${field} in ${mode} requires correction and never creates it`, async () => {
    const f = mode === 'setup' ? new SheetFixture() : ready();
    const s = f.sheet(c.applications), index = s.values[0].indexOf(field);
    s.values = s.values.map(row => row.filter((_, i) => i !== index));
    const before = structuredClone(f.sheets);
    await assert.rejects(runGraph(workflow, f, { ...env, WORKFLOW_B_MODE: mode }), new RegExp('MISSING_COLUMN:' + field));
    assert.deepEqual(f.sheets, before); assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  });

test('generated hyperlink lifecycle freezes latest selection/body/URL and retries identical payloads', async () => {
  await verifyHyperlinkWorkflow(workflow);
});
for (const change of [{ snapshot_version: 'unknown-v2' }, { snapshot_version: '' }, { publication_description: '' },
  { project_link: 'https://different.test' }, { project_link_text: 'body' }, { draft_description: 'Corrupted' }])
  test(`inconsistent frozen link metadata fails explicitly: ${JSON.stringify(change)}`, () => {
    const f = ready(); f.commit(plan(f).requests);
    for (const [key, value] of Object.entries(change)) f.edit(c.items, 2, key, value);
    assert.throws(() => state(f), /UNSUPPORTED_SNAPSHOT_FORMAT|INCOMPLETE_SNAPSHOT_CONTENT/);
  });
test('mixed snapshot formats inside one batch are rejected', () => {
  const f = ready([example('a', 10), example('b', 20)]); f.commit(plan(f).requests);
  const item = { ...state(f).active.items[1], ...Object.fromEntries(PRESENTATION_FIELDS.map(k => [k, ''])) };
  for (const key of PRESENTATION_FIELDS) f.edit(c.items, 3, key, '');
  f.edit(c.items, 3, 'rendered_text', renderVacancy(item));
  assert.throws(() => state(f), /INCONSISTENT_SNAPSHOT_FORMAT/);
});
test('legacy O-005 snapshots publish and retry without new columns or mutable source fields', async () => {
  const f = ready([{ ...example(), draft_description: 'Approved [Other](https://other.test) <b>plain</b>' }]); f.commit(plan(f).requests); legacy(f);
  const s = f.sheet(c.applications), omitted = ['project_link_text', 'Project Website Link', 'draft_description'];
  const keep = s.values[0].map((h, i) => omitted.includes(h) ? -1 : i).filter(i => i >= 0);
  s.values = s.values.map(row => keep.map(i => row[i]));
  const oldContent = state(f).active.items[0].rendered_text;
  let fail = true, id = 100; const sends = [];
  const telegram = async (_, p) => {
    if (p.operation === 'get') return [{ ok: true, result: { id: Number(env.WORKFLOW_B_TELEGRAM_CHAT_ID), type: 'channel' } }];
    if (p.operation === 'administrators') return [{ status: 'administrator', can_post_messages: true, user: { id: 222, is_bot: true } }];
    sends.push(p.text); if (fail && sends.length === 2) throw Error('uncertain');
    return [{ ok: true, result: { message_id: id++, date: 1789862400, chat: { id: Number(env.WORKFLOW_B_TELEGRAM_CHAT_ID), type: 'channel' } } }];
  };
  await assert.rejects(runGraph(workflow, f, { ...env, WORKFLOW_B_MODE: 'run' }, undefined, telegram), /FAILED/);
  // Operator cleanup is modeled externally; retry always starts at START.
  fail = false; await runGraph(workflow, f, { ...env, WORKFLOW_B_MODE: 'run' }, undefined, telegram);
  assert.deepEqual(sends.slice(0, 2), sends.slice(2, 4));
  assert.ok(sends[1].includes('\n\nApproved [Other](https://other.test) &lt;b&gt;plain&lt;/b&gt;\n\nДетали: '));
  assert.equal((sends[1].match(/<a /g) ?? []).length, 1);
  assert.deepEqual(f.sheet(c.items).values[0], LEGACY_ITEM_FIELDS);
  assert.equal(state(f).items[0].rendered_text, oldContent);
});
test('new snapshot columns append atomically with claim; legacy history and extra columns survive', () => {
  const f = ready(); f.commit(plan(f).requests); legacy(f);
  for (const [key, value] of Object.entries({ batch_status: 'COMPLETED', started_at: now, completed_at: now,
    start_telegram_message_id: 1, end_telegram_message_id: 3 })) f.edit(c.batches, 2, key, value);
  for (const [key, value] of Object.entries({ item_state: 'SENT', telegram_message_id: 2, published_at: now })) f.edit(c.items, 2, key, value);
  const itemTab = f.sheet(c.items); itemTab.values[0] = [...itemTab.values[0], 'historical_note']; itemTab.values[1].push('Keep me');
  const historical = structuredClone(itemTab.values[1]);
  const app = f.sheet(c.applications), next = example('new', 20); app.values.push(app.values[0].map(k => next[k] ?? ''));
  f.control(c, true); const one = plan(f), two = plan(f);
  assert.equal(itemTab.values[0].includes('snapshot_version'), false, 'planning has no side effects');
  f.commit(one.requests);
  assert.deepEqual(f.sheet(c.items).values[1], historical);
  assert.deepEqual(f.sheet(c.items).values[0], [...LEGACY_ITEM_FIELDS, 'historical_note', ...PRESENTATION_FIELDS]);
  assert.equal(state(f).active.items[0].snapshot_version, PRESENTATION_SNAPSHOT_VERSION);
  const winner = structuredClone(f.sheets);
  assert.throws(() => f.commit(two.requests)); assert.deepEqual(f.sheets, winner);
});


test('insertion beside literal backslashes and exclamation marks preserves visible text', () => {
  for (const [draft, selection] of [
  [
    "C:\\Project",
    "Project"
  ],
  [
    "Project\\",
    "Project\\"
  ],
  [
    "C:\\\\Project",
    "Project"
  ],
  [
    "!Project",
    "Project"
  ],
  [
    "\\!Project",
    "Project"
  ],
  [
    "\\\\!Project",
    "Project"
  ],
  [
    "Project\\Again",
    "Project\\"
  ],
  [
    "Project \\? again",
    "Project \\"
  ]
]) {
    const body = renderProjectBody(draft, selection, url);
    assert.equal(parseInlineLinks(body).visible, parseInlineLinks(draft).visible, draft);
    assert.equal(parseInlineLinks(body).spans.find(s => s.kind === 'link').text, selection);
    assert.equal(renderProjectBody(body, selection, url), body);
  }
});
