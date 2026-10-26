import { credentialEnv } from './workflow-b-credentials-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  APPLICATION_FIELDS, BATCH_FIELDS, ITEM_FIELDS, sheetsConfig, setupPlan, readPlan, inspectPlan,
  newBatchPlan, table, applicationRows, projectionRows, projectionFormula,
} from './workflow-b-sheets.mjs';
import { renderVacancy, PRESENTATION_FIELDS } from './workflow-b-domain.mjs';
import { SheetFixture, example, runGraph, bundledDomain } from './workflow-b-sheets-fixture.mjs';
const env = { GOOGLE_SHEETS_DOCUMENT_ID: 'fixture-sheet',
  WORKFLOW_B_TELEGRAM_CHAT_ID: '-1001234567890', WORKFLOW_B_TELEGRAM_EXPECTED_BOT_ID: '222' };
let ackId = 100;
const telegram = async (_, p) => p.operation === 'get'
  ? [{ ok: true, result: { id: Number(env.WORKFLOW_B_TELEGRAM_CHAT_ID), type: 'channel' } }]
  : p.operation === 'administrators'
    ? [{ status: 'administrator', can_post_messages: true, user: { id: 222, is_bot: true } }]
    : [{ ok: true, result: { message_id: ackId++, date: 1789800000,
      chat: { id: Number(env.WORKFLOW_B_TELEGRAM_CHAT_ID), type: 'channel' } } }];
const c = sheetsConfig(env), now = '2026-09-10T12:00:00.000Z';
function ready(rows = [example()]) {
  const f = new SheetFixture(rows);
  f.commit(setupPlan(c, f.metadata(), f.sheet(c.applications).values).requests);
  rows.forEach((r, i) => APPLICATION_FIELDS.forEach(field => f.edit(c.applications, i + 2, field, r[field] ?? '')));
  f.calls = []; return f;
}
const inspect = f => inspectPlan(c, f.metadata(), f.get(readPlan(c, f.metadata()).url));
function prepare(f, uuid = randomUUID()) {
  return newBatchPlan(c, f.metadata(), inspect(f).state, f.sheet(c.applications).values, uuid, now);
}
function created() { const f = ready(); f.control(c, true); const plan = prepare(f); f.commit(plan.requests); return { f, plan }; }
function completed(f) {
  const batch = f.sheet(c.batches).values[1];
  for (const [field, value] of Object.entries({ batch_status: 'COMPLETED', started_at: now, completed_at: now, start_telegram_message_id: '1', end_telegram_message_id: '3' })) batch[BATCH_FIELDS.indexOf(field)] = value;
  const item = f.sheet(c.items).values[1];
  for (const [field, value] of Object.entries({ item_state: 'SENT', telegram_message_id: '2', published_at: now })) item[ITEM_FIELDS.indexOf(field)] = value;
  for (const [field, value] of Object.entries({ telegram_message_id: '2', published_at: now })) f.edit(c.applications, 2, field, value);
}
const buildDir = mkdtempSync(join(tmpdir(), 'workflow-b-m2-'));
const build = spawnSync(process.execPath, ['n8n/build-workflow-b.mjs', join(buildDir, 'b.json')], { encoding: 'utf8', env: credentialEnv });
assert.equal(build.status, 0, build.stderr);
const workflow = JSON.parse(readFileSync(join(buildDir, 'b.json'), 'utf8'));
rmSync(buildDir, { recursive: true, force: true });

test('setup appends only seven B headers; raw canonical ownership and all upstream values survive', () => {
  const raw = new SheetFixture(); const before = structuredClone(raw.sheets[0].values);
  const plan = setupPlan(c, raw.metadata(), before); raw.commit(plan.requests);
  assert.deepEqual(raw.sheets[0].values[0].slice(before[0].length), APPLICATION_FIELDS);
  assert.deepEqual(raw.sheets[0].values[1], before[1]);
  assert.ok(!plan.requests.some(r => r.deleteSheet || r.deleteDimension || r.cutPaste));
});
test('setup refuses existing B tabs rather than overwriting persistence or operator fields', () => {
  const f = ready(); assert.throws(() => setupPlan(c, f.metadata(), f.sheet(c.applications).values), /SETUP_TAB_ALREADY_EXISTS/);
});
test('setup installs checkbox validation and canonical decision dropdown without machine enum', () => {
  const f = new SheetFixture(), p = setupPlan(c, f.metadata(), f.sheet(c.applications).values);
  const rules = p.requests.filter(r => r.setDataValidation).map(r => r.setDataValidation.rule);
  assert.equal(rules[0].condition.type, 'BOOLEAN');
  assert.deepEqual(rules[1].condition.values.map(v => v.userEnteredValue), ['PUBLISH', 'REJECT']);
});
for (const [decision, publishedAt, message, expected] of [
  ['', '', '', 'review'], ['PUBLISH', '', '', 'review'], ['REJECT', '', '', 'archive'],
  ['PUBLISH', now, '7', 'archive'], ['', now, '8', 'archive'], ['PUBLISH', now, '', 'review'],
]) test(`projection ${JSON.stringify([decision, publishedAt, message])} belongs to ${expected}`, () => {
  const row = { ...example(), human_decision: decision, published_at: publishedAt, telegram_message_id: message,
    batch_id: 'old', batch_position: 1, telegram_message_url: 'https://t.me/example/7' };
  const views = projectionRows([row]); assert.deepEqual(views[expected], [row]);
  assert.equal(views[expected === 'review' ? 'archive' : 'review'].length, 0);
});
test('Archive preserves machine context and publication metadata in full', () => {
  const row = { ...example(), human_decision: 'REJECT', batch_id: 'b', batch_position: 2, published_at: now, telegram_message_url: 'url' };
  assert.deepEqual(projectionRows([row]).archive[0], row);
});
test('projection formulas use canonical rows, correct headers, live full columns, and escaped tab names', () => {
  const f = ready(); const headers = f.sheet(c.applications).values[0];
  for (const archive of [false, true]) {
    const formula = projectionFormula({ ...c, applications: "Operator's Applications" }, headers, archive);
    assert.match(formula, /'Operator''s Applications'!A1:V1/);
    assert.match(formula, /BYROW/); assert.match(formula, /IFNA/); assert.match(formula, /REJECT/);
    assert.ok(formula.includes(archive ? '>0),MAKEARRAY' : '=0),MAKEARRAY'));
  }
});
for (const decision of ['', 'PUBLISH', 'REJECT']) test(`reads human_decision ${JSON.stringify(decision)} through Sheets adapter`, () => {
  const f = ready([{ ...example(), human_decision: decision }]);
  assert.equal(applicationRows(c, f.sheet(c.applications).values, inspect(f).state)[0].human_decision, decision);
});
for (const status of ['REJECTED', 'ERROR', 'NEEDS_REVIEW', 'UNRECOGNIZED_FUTURE']) test(`upstream ${status} remains advisory and untouched`, () => {
  const f = ready([{ ...example(), processing_status: status }]); f.control(c, true);
  const before = structuredClone(f.sheet(c.applications).values[1]); f.commit(prepare(f).requests);
  const headers = f.sheet(c.applications).values[0];
  headers.forEach((h, i) => { if (!['batch_id', 'batch_position'].includes(h)) assert.equal(f.sheet(c.applications).values[1][i], before[i]); });
  assert.equal(f.sheet(c.applications).values.length, 2);
});
test('inactive control never creates a new batch', () => { assert.equal(inspect(ready()).kind, 'INACTIVE'); });
test('control accepts checkbox booleans and rejects misleading strings', () => {
  const f = ready(); f.control(c, 'TRUE'); assert.throws(() => inspect(f), /INVALID_CONTROL_VALUE/);
});
test('valid action persists one CREATED batch, stable UUID, count, empty acknowledgement fields and resets control', () => {
  const { f, plan } = created(), state = inspect(f).state;
  assert.match(plan.batch.batch_id, /^wb-[0-9a-f-]{36}$/);
  assert.equal(state.active.batch_id, plan.batch.batch_id); assert.equal(state.active.batch_status, 'CREATED');
  assert.equal(state.active.vacancy_count, 1); assert.equal(state.control, false);
  for (const h of ['started_at', 'completed_at', 'start_telegram_message_id', 'end_telegram_message_id', 'last_publication_error', 'diagnostic_or_unknown_state_note']) assert.equal(state.active[h], '');
  for (const h of ['telegram_message_id', 'telegram_message_url', 'published_at']) assert.equal(state.active.items[0][h], '');
});
test('repeated execution without another action reconstructs same batch', () => {
  const { f, plan } = created(); for (let i = 0; i < 3; i++) assert.equal(inspect(f).batch.batch_id, plan.batch.batch_id);
  assert.equal(f.sheet(c.batches).values.length, 2);
});
test('active checkbox with existing unfinished batch loads it without resetting control', () => {
  const { f } = created(); f.control(c, true); const p = inspect(f); assert.equal(p.kind, 'ACTIVE_BATCH');
  assert.deepEqual(p.requests, []); assert.equal(inspect(f).state.control, true);
});
test('whole-batch failure persists nothing and leaves checkbox available for correction', () => {
  const f = ready([example(), { ...example('bad', 20), draft_description: '' }]); f.control(c, true);
  const before = structuredClone(f.sheets), p = prepare(f); assert.equal(p.kind, 'PREFLIGHT_FAILED');
  assert.deepEqual(p.requests, []); assert.deepEqual(f.sheets, before); assert.equal(inspect(f).state.control, true);
});
test('description configuration passes to unchanged M1 preflight', () => {
  const f = ready(); f.control(c, true);
  const p = newBatchPlan({ ...c, MAX_PUBLICATION_DESCRIPTION_CHARS: 1 }, f.metadata(), inspect(f).state, f.sheet(c.applications).values, randomUUID(), now);
  assert.equal(p.kind, 'PREFLIGHT_FAILED'); assert.equal(p.errors[0].code, 'DESCRIPTION_TOO_LONG');
});
test('all items persist with stable positions and raw order type', () => {
  const f = ready([example('a', '30'), example('b', 10)]); f.control(c, true); f.commit(prepare(f).requests);
  const items = inspect(f).batch.items; assert.deepEqual(items.map(i => [i.application_id, i.batch_position, i.publication_order]), [['b', 1, 10], ['a', 2, '30']]);
  assert.equal(items[1].application_row_number, 2); assert.equal(items[0].application_sheet_id, 0);
});
test('frozen content reconstructs exact M1 output and is immutable after source edits', () => {
  const { f, plan } = created(); f.edit(c.applications, 2, 'draft_description', 'changed later'); f.edit(c.applications, 2, 'Contact Info', 'later contact');
  const item = inspect(f).batch.items[0]; assert.equal(item.rendered_text, plan.batch.items[0].rendered_text);
  assert.equal(item.rendered_text, renderVacancy(item)); assert.ok(Object.isFrozen(item));
});
test('reconstruction requires no Applications data at all', () => {
  const { f } = created(); f.sheets = f.sheets.filter(s => s.properties.title !== c.applications);
  assert.equal(inspect(f).kind, 'ACTIVE_BATCH');
});
test('atomic overlapping plans permit one winner and no partial loser writes', () => {
  const f = ready(); f.control(c, true); const first = prepare(f), second = prepare(f);
  f.commit(first.requests); const winner = structuredClone(f.sheets);
  assert.throws(() => f.commit(second.requests), /CLAIM_CONFLICT/); assert.deepEqual(f.sheets, winner);
  assert.equal(inspect(f).batch.batch_id, first.batch.batch_id);
});
test('application associated with unfinished batch is mapped to existing claim', () => {
  const { f, plan } = created(); const row = applicationRows(c, f.sheet(c.applications).values, inspect(f).state)[0];
  assert.equal(row.active_unfinished_batch_id, plan.batch.batch_id);
});
for (const status of ['CREATED', 'PUBLISHING', 'FAILED']) test(`${status} is an unfinished active batch`, () => {
  const { f } = created(); f.sheet(c.batches).values[1][BATCH_FIELDS.indexOf('batch_status')] = status;
  assert.equal(inspect(f).batch.batch_status, status);
});
test('completed history allows new rows; stale historical fence cannot delete a new winner', () => {
  const { f } = created(); completed(f);
  const headers = f.sheet(c.applications).values[0]; f.sheet(c.applications).values.push(headers.map(h => example('next', 20)[h] ?? ''));
  f.control(c, true); assert.equal(inspect(f).kind, 'READ_LATEST_APPLICATIONS');
  const p1 = prepare(f), p2 = prepare(f); f.commit(p1.requests);
  assert.equal(inspect(f).batch.items[0].application_id, 'next');
  assert.throws(() => f.commit(p2.requests), /missing sheet/); assert.equal(f.sheet(c.batches).values.length, 3);
});
for (const [label, mutate, error] of [
  ['missing item', f => f.sheet(c.items).values.pop(), /INCOMPLETE_SNAPSHOT_COUNT/],
  ['missing batch', f => f.sheet(c.batches).values.pop(), /ORPHAN_FROZEN_ITEM/],
  ['bad position', f => f.sheet(c.items).values[1][ITEM_FIELDS.indexOf('batch_position')] = 4, /INCOMPLETE_SNAPSHOT_IDENTITY/],
  ['changed content', f => f.sheet(c.items).values[1][ITEM_FIELDS.indexOf('draft_description')] = 'corrupt', /INCOMPLETE_SNAPSHOT_CONTENT/],
  ['missing claim', f => f.sheets.pop(), /MISSING_OR_MISMATCHED_ACTIVE_CLAIM/],
  ['orphan claim', f => f.sheet(c.claim).values[0][0] = 'unknown', /ORPHAN_OR_INCOMPLETE_CLAIM/],
  ['unknown batch state', f => f.sheet(c.batches).values[1][BATCH_FIELDS.indexOf('batch_status')] = 'BOGUS', /INVALID_BATCH_STATE/],
  ['unknown item state', f => f.sheet(c.items).values[1][ITEM_FIELDS.indexOf('item_state')] = 'BOGUS', /INVALID_ITEM_STATE/],
]) test(`incomplete persistence stops deterministically: ${label}`, () => {
  const { f } = created(); mutate(f); assert.throws(() => inspect(f), error);
});
test('write failure before commit leaves no batch, claim, application association or reset', () => {
  const f = ready(); f.control(c, true); const p = prepare(f), before = structuredClone(f.sheets); f.failBeforeCommit = true;
  assert.throws(() => f.commit(p.requests), /SIMULATED_WRITE_FAILURE/); assert.deepEqual(f.sheets, before);
});
test('Original Link is fixed; old matching configuration is accepted but other sources are rejected', () => {
  assert.equal(c.details_column, 'Original Link');
  assert.equal(sheetsConfig({ ...env, WORKFLOW_B_DETAILS_LINK_COLUMN: 'Original Link' }).details_column, 'Original Link');
  assert.throws(() => sheetsConfig({ ...env, WORKFLOW_B_DETAILS_LINK_COLUMN: 'Project Website Link' }), /O005_ORIGINAL_LINK_ONLY/);
  const f = ready(); f.control(c, true);
  const p = newBatchPlan({ ...c, details_column: 'Project Website Link' }, f.metadata(), inspect(f).state, f.sheet(c.applications).values, randomUUID(), now);
  assert.equal(p.batch.items[0].details_link, example()['Original Link']);
});
test('RAW string cells preserve formula-looking human text as text', () => {
  const f = ready([{ ...example(), draft_description: '=IMPORTDATA("private")', project_link_text: 'IMPORTDATA' }]); f.control(c, true);
  const p = prepare(f); const cells = p.requests.find(r => r.appendCells?.sheetId === f.sheet(c.items).properties.sheetId).appendCells.rows[0].values;
  assert.deepEqual(cells[ITEM_FIELDS.indexOf('draft_description')].userEnteredValue, { stringValue: '=IMPORTDATA("private")' });
});
test('duplicate identity and orphan application claims fail closed', () => {
  for (const rows of [[example(), example()], [{ ...example(), batch_id: 'missing' }]]) {
    const f = ready(rows); f.control(c, true); assert.throws(() => prepare(f), /DUPLICATE_APPLICATION_ID|ORPHAN_APPLICATION_CLAIM/);
  }
});
test('invalid configuration and malformed headers fail without mutations', () => {
  assert.throws(() => sheetsConfig(), /SPREADSHEET_ID/);
  assert.throws(() => sheetsConfig({ ...env, WORKFLOW_B_CONTROL_CELL: 'A1' }), /CONTROL_CELL/);
  assert.throws(() => sheetsConfig({ ...env, WORKFLOW_B_ARCHIVE_TAB: 'Applications' }), /TAB_NAMES/);
  assert.throws(() => table([['application_id', 'application_id']]), /DUPLICATE_HEADERS/);
});
test('config externalizes all tabs, control cell, maximum and versions', () => {
  const x = sheetsConfig({ ...env, WORKFLOW_B_CONTROL_CELL: 'D8', MAX_PUBLICATION_DESCRIPTION_CHARS: '800',
    WORKFLOW_B_ITEMS_TAB: 'Frozen', WORKFLOW_B_VERSION: 'v', WORKFLOW_B_CONFIG_VERSION: 'c' });
  assert.equal(x.items, 'Frozen'); assert.equal(x.MAX_PUBLICATION_DESCRIPTION_CHARS, 800); assert.equal(x.workflow_version, 'v');
  const f = new SheetFixture(); const p = setupPlan(x, f.metadata(), f.sheet(c.applications).values); f.commit(p.requests);
  assert.equal(f.sheet(x.control).values[7][3], false);
});
test('generated graph executes setup without credentials, external services or publication', async () => {
  const f = new SheetFixture(); const { result, visited } = await runGraph(workflow, f, { ...env, WORKFLOW_B_MODE: 'setup' });
  assert.equal(result.kind, 'SETUP_COMPLETE'); assert.ok(!visited.includes('Read Latest Applications'));
});
test('generated graph reads latest edits after control inspection and freezes all edited fields', async () => {
  const f = ready([example('a', 10), example('b', 20)]); f.control(c, true);
  const { result, visited } = await runGraph(workflow, f, env, fixture => {
    fixture.edit(c.applications, 2, 'draft_description', 'Latest body'); fixture.edit(c.applications, 2, 'project_link_text', 'Latest'); fixture.edit(c.applications, 2, 'publication_order', 30);
    fixture.edit(c.applications, 2, 'Original Link', 'https://example.test/latest?source=edited'); fixture.edit(c.applications, 2, 'Contact Info', 'latest contact');
  }, telegram);
  assert.equal(result.kind, 'COMPLETED'); const item = result.batch.items[1];
  assert.deepEqual([item.draft_description, item.publication_order, item.details_link, item.contact], ['Latest body', 30, 'https://example.test/latest?source=edited', 'latest contact']);
  assert.ok(visited.indexOf('Read Latest Applications') > visited.indexOf('Inspect Control And Active Batch'));
  assert.equal(inspect(f).state.control, false);
});
test('generated active path never reads mutable Applications content', async () => {
  const { f } = created(); const { result, visited } = await runGraph(workflow, f, env, undefined, telegram);
  assert.equal(result.kind, 'COMPLETED'); assert.ok(!visited.includes('Read Latest Applications'));
});
test('generated graph recovers persisted batch after lost Sheets write response', async () => {
  const f = ready(); f.control(c, true); f.failAfterCommit = true;
  const { result, visited } = await runGraph(workflow, f, env, undefined, telegram);
  assert.equal(result.kind, 'COMPLETED'); assert.ok(visited.includes('Verify Commit Or Recover Winner'));
  const second = await runGraph(workflow, f, env); assert.equal(second.result.kind, 'INACTIVE');
});
test('generated graph surfaces uncommitted write failure without false success', async () => {
  const f = ready(); f.control(c, true); f.failBeforeCommit = true;
  await assert.rejects(runGraph(workflow, f, env), /UNCONFIRMED_SHEETS_WRITE/);
  assert.equal(f.sheet(c.batches).values.length, 1);
});
test('generated graph never writes on inactive or failed preflight paths', async () => {
  for (const active of [false, true]) {
    const f = ready([{ ...example(), publication_order: '' }]); f.control(c, active);
    const { result } = await runGraph(workflow, f, env); assert.equal(result.kind, active ? 'PREFLIGHT_FAILED' : 'INACTIVE');
    assert.ok(f.calls.every(call => call.method === 'GET'));
  }
});
test('all generated Code programs compile and use the unchanged M1 source', () => {
  const domain = bundledDomain();
  for (const n of workflow.nodes.filter(n => n.type.endsWith('.code'))) {
    assert.ok(n.parameters.jsCode.startsWith(domain)); assert.doesNotThrow(() => new Function(n.parameters.jsCode));
  }
});
test('generated graph is inactive with Google HTTP endpoints, native Telegram, execution lookup and no LLM transport', () => {
  assert.equal(workflow.active, false);
  for (const n of workflow.nodes) {
    assert.ok(['manualTrigger', 'code', 'httpRequest', 'if', 'crypto', 'telegram', 'wait', 'n8n'].some(t => n.type === `n8n-nodes-base.${t}`));
    if (n.type.endsWith('.httpRequest')) {
      assert.equal(n.parameters.nodeCredentialType, 'googleApi'); assert.equal(n.retryOnFail, false);
      assert.match(n.parameters.url, /sheets\.googleapis\.com|\$json\.url/);
    }
  }
  assert.doesNotMatch(JSON.stringify(workflow), /api\.telegram|api\.openai|langchain|botToken|private_key|BEGIN PRIVATE/i);
});

test('completed status without canonical completion evidence cannot release the claim', () => {
  const { f } = created(); f.sheet(c.batches).values[1][BATCH_FIELDS.indexOf('batch_status')] = 'COMPLETED';
  assert.throws(() => inspect(f), /INCOMPLETE_COMPLETED_BATCH/);
});
test('durable SENT item prevents republishing even if application metadata was cleared', () => {
  const { f } = created(); completed(f);
  for (const field of ['batch_id', 'batch_position', 'telegram_message_id', 'published_at']) f.edit(c.applications, 2, field, '');
  f.control(c, true); assert.equal(prepare(f).kind, 'NO_CANDIDATES');
});
test('no candidates consumes the control without creating empty batch or claim', () => {
  const f = ready([{ ...example(), human_decision: 'REJECT' }]); f.control(c, true);
  const p = prepare(f); assert.equal(p.kind, 'NO_CANDIDATES'); f.commit(p.requests);
  assert.equal(inspect(f).state.control, false); assert.equal(f.sheet(c.batches).values.length, 1);
});
test('multiple unfinished batches and duplicate batch IDs never look like clean new work', () => {
  for (const duplicate of [true, false]) {
    const { f } = created(); const batch = structuredClone(f.sheet(c.batches).values[1]);
    if (!duplicate) {
      batch[BATCH_FIELDS.indexOf('batch_id')] = 'other';
      const item = structuredClone(f.sheet(c.items).values[1]); item[ITEM_FIELDS.indexOf('batch_id')] = 'other'; f.sheet(c.items).values.push(item);
    }
    f.sheet(c.batches).values.push(batch); assert.throws(() => inspect(f), /INVALID_BATCH_IDENTITY|MULTIPLE_UNFINISHED_BATCHES/);
  }
});
test('oversized frozen cells fail before any Sheet mutation without truncation', () => {
  const f = ready([{ ...example(), 'Project Website Link': 'https://project.test/' + 'x'.repeat(50001) }]); f.control(c, true);
  const before = structuredClone(f.sheets);
  assert.throws(() => newBatchPlan({ ...c, MAX_PUBLICATION_DESCRIPTION_CHARS: 60000 }, f.metadata(), inspect(f).state, f.sheet(c.applications).values, randomUUID(), now), /SHEET_CELL_TOO_LARGE/);
  assert.deepEqual(f.sheets, before);
});
test('generated overlapping loser re-reads and exposes winner instead of sending cached writes again', async () => {
  const f = ready(); f.control(c, true); const winner = prepare(f);
  const realCommit = f.commit.bind(f); let interleave = true;
  f.commit = requests => { if (interleave) { interleave = false; realCommit(winner.requests); } return realCommit(requests); };
  const { result } = await runGraph(workflow, f, env);
  assert.equal(result.batch.batch_id, winner.batch.batch_id); assert.equal(result.overlapping_winner, true);
  assert.equal(result.recovered_after_write_error, true); assert.equal(f.sheet(c.batches).values.length, 2);
});

for (const state of ['NOT_SENT', 'SENT']) test(`reconstruction preserves ${state} and existing per-item metadata without actions`, () => {
  const { f } = created(); const row = f.sheet(c.items).values[1];
  for (const [field, value] of Object.entries({ item_state: state, telegram_message_id: '42', telegram_message_url: 'https://t.me/fixture/42', published_at: now })) row[ITEM_FIELDS.indexOf(field)] = value;
  const callsBefore = f.calls.filter(c => c.method === 'POST').length;
  const item = inspect(f).batch.items[0]; assert.equal(item.item_state, state);
  assert.equal(item.telegram_message_id, '42'); assert.equal(item.telegram_message_url, 'https://t.me/fixture/42'); assert.equal(item.published_at, now);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, callsBefore);
});

test('O-005 never substitutes Project Link for a missing Original Link', () => {
  const f = ready([{ ...example(), 'Original Link': '' }]); f.control(c, true);
  const before = structuredClone(f.sheets), p = prepare(f);
  assert.equal(p.kind, 'PREFLIGHT_FAILED');
  assert.ok(p.errors.some(e => e.field === 'details_link' && e.code === 'INVALID_DETAILS_LINK' && e.row_number === 2));
  assert.deepEqual(p.requests, []); assert.deepEqual(f.sheets, before);
});
test('O-005 persists full Original Link and no independent display-text column', () => {
  const href = 'https://hh.ru/vacancy/137336583?hhtmFrom=vacancy_search_list';
  const f = ready([{ ...example(), 'Original Link': href, 'Project Website Link': 'https://other.example/unrelated' }]);
  f.control(c, true); f.commit(prepare(f).requests);
  const item = inspect(f).batch.items[0];
  assert.equal(item.details_link, href);
  assert.ok(item.rendered_text.includes(`Детали: [hh.ru/vacancy/137336583](${href})`));
  assert.ok(!item.rendered_text.split('Детали: ')[1].includes('other.example'));
  assert.ok(item.publication_description.includes('https://other.example/unrelated'));
  assert.deepEqual(f.sheet(c.items).values[0], ITEM_FIELDS);
  assert.ok(![...ITEM_FIELDS, ...APPLICATION_FIELDS].some(h => /display|label|details_text/.test(h)));
});
test('latest Original Link edits feed new rendering and subsequent edits cannot change frozen href/text', async () => {
  const f = ready(); f.control(c, true);
  const href = 'https://hh.ru/vacancy/137336583?hhtmFrom=vacancy_search_list';
  const { result } = await runGraph(workflow, f, env, fixture => fixture.edit(c.applications, 2, 'Original Link', href), telegram);
  assert.equal(result.batch.items[0].details_link, href);
  f.edit(c.applications, 2, 'Original Link', 'https://example.test/edited-after-freeze?new=yes');
  assert.deepEqual(table(f.sheet(c.items).values).rows.map(({row_number, ...item}) => item), result.batch.items);
});
test('generated active path preserves pre-O-005 batch content without migration or source reread', async () => {
  const { f } = created();
  const saved = f.sheet(c.items).values[1];
  for (const key of PRESENTATION_FIELDS) saved[ITEM_FIELDS.indexOf(key)] = '';
  saved[ITEM_FIELDS.indexOf('details_link')] = '[Legacy title](https://legacy.example/job?full=query)';
  saved[ITEM_FIELDS.indexOf('rendered_text')] = '·1·\n\nApproved body\n\nДетали: [Legacy title](https://legacy.example/job?full=query)\n\nКонтакт: @editor';
  const before = structuredClone(f.sheets);
  await assert.rejects(runGraph(workflow, f, env), /INVALID_DETAILS_LINK/);
  assert.deepEqual(f.sheets, before);
  assert.equal(inspect(f).batch.items[0].rendered_text, saved[ITEM_FIELDS.indexOf('rendered_text')]);
});

for (const invalidState of ['FAILED', 'UNKNOWN']) test(`O-007 reconstruction rejects obsolete item state ${invalidState}`, () => {
  const { f } = created(); f.edit(c.items, 2, 'item_state', invalidState);
  assert.throws(() => inspect(f), /INVALID_ITEM_STATE/);
});
