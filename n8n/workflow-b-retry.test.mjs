import { credentialEnv } from './workflow-b-credentials-fixture.mjs';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SheetFixture, example, runGraph } from './workflow-b-sheets-fixture.mjs';
import { sheetsConfig, setupPlan, newBatchPlan, persistenceState, readPlan, BATCH_FIELDS, ITEM_FIELDS } from './workflow-b-sheets.mjs';
import { renderVacancy } from './workflow-b-domain.mjs';

const directory = mkdtempSync(join(tmpdir(), 'workflow-b-m4-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const artifact = join(directory, 'workflow.json');
execFileSync(process.execPath, [fileURLToPath(new URL('./build-workflow-b.mjs', import.meta.url)), artifact], { env: credentialEnv });
const workflow = JSON.parse(readFileSync(artifact, 'utf8'));
const env = { GOOGLE_SHEETS_DOCUMENT_ID: 'synthetic-sheet', WORKFLOW_B_MODE: 'run',
  WORKFLOW_B_TELEGRAM_CHAT_ID: '-1001234567890', WORKFLOW_B_TELEGRAM_EXPECTED_BOT_ID: '222' };
const c = sheetsConfig(env);
const state = f => persistenceState(c, f.metadata(), f.get(readPlan(c, f.metadata()).url));
const stamp = '2026-09-19T10:00:00.000Z';
const delivery = ['telegram_message_id', 'telegram_message_url', 'published_at'];
const batchDelivery = ['batch_status', 'started_at', 'completed_at', 'start_telegram_message_id',
  'end_telegram_message_id', 'last_publication_error', 'diagnostic_or_unknown_state_note'];
function ready() {
  const rows = [example('a', 10), example('b', 20), example('c', 30)], f = new SheetFixture(rows);
  f.commit(setupPlan(c, f.metadata(), f.sheet(c.applications).values).requests);
  for (const [i, row] of rows.entries()) for (const k of ['human_decision', 'publication_order'])
    f.edit(c.applications, i + 2, k, row[k]);
  f.control(c, true);
  f.commit(newBatchPlan(c, f.metadata(), state(f), f.sheet(c.applications).values, randomUUID(), stamp).requests);
  f.calls = [];
  return f;
}
function fake(f, options = {}) {
  const sends = [], calls = [];
  const transport = async (node, parameters) => {
    calls.push(parameters.operation);
    if (parameters.operation === 'get') return [options.chat ?? { ok: true,
      result: { id: Number(env.WORKFLOW_B_TELEGRAM_CHAT_ID), type: 'channel' } }];
    if (parameters.operation === 'administrators') return options.admins ?? [{
      status: 'administrator', can_post_messages: true, user: { id: 222, is_bot: true },
    }];
    assert.equal(parameters.operation, 'sendMessage');
    const batch = state(f).active;
    assert.equal(batch.batch_status, 'PUBLISHING');
    const index = sends.length;
    sends.push({ parameters, batch: structuredClone(batch), sheets: structuredClone(f.sheets) });
    if (options.failAt === index) throw new Error('lost Telegram response');
    if (options.responses?.[index]) return [options.responses[index]];
    return [{ ok: true, result: { message_id: (options.idBase ?? 1000) + index, date: 1789800000 + index,
      chat: { id: Number(env.WORKFLOW_B_TELEGRAM_CHAT_ID), type: 'channel' } } }];
  };
  return { transport, sends, calls, run: hooks => runGraph(workflow, f, { ...env, ...options.env }, undefined, transport, hooks) };
}
async function stopped(at) {
  const f = ready(), t = fake(f, { failAt: at });
  await assert.rejects(t.run(), /FAILED/);
  assert.equal(state(f).active.batch_status, 'FAILED');
  assert.equal(t.sends.length, at + 1);
  return { f, first: t };
}
function frozen(f) {
  const s = state(f), pick = (row, fields, omit) => Object.fromEntries(fields.filter(k => !omit.includes(k)).map(k => [k, row[k]]));
  return { batches: s.batches.map(b => pick(b, BATCH_FIELDS, batchDelivery)),
    items: s.items.map(i => pick(i, ITEM_FIELDS, ['item_state', ...delivery])) };
}
function assertReset(send) {
  const batch = send.batch;
  for (const field of batchDelivery.filter(k => k !== 'batch_status')) assert.equal(batch[field], '', field);
  for (const item of batch.items) {
    assert.equal(item.item_state, 'NOT_SENT');
    for (const field of delivery) assert.equal(item[field], '', field);
    const app = send.sheets.find(s => s.properties.title === c.applications);
    for (const field of delivery) assert.equal(app.values[item.application_row_number - 1][app.values[0].indexOf(field)] ?? '', '', field);
  }
}
for (const at of [0, 1, 2, 3, 4]) test('failure at sequence ' + at + ' retries the entire frozen batch from START', async () => {
  const { f, first } = await stopped(at), before = frozen(f), prior = state(f).active;
  assert.match(prior.diagnostic_or_unknown_state_note, /manual Telegram cleanup.*full-batch restart from START/);
  assert.equal(prior.items.filter(i => i.item_state === 'SENT').length, Math.max(0, at - 1));
  f.edit(c.applications, 2, 'draft_description', 'changed mutable body');
  f.edit(c.applications, 2, 'Original Link', 'https://changed.test');
  f.edit(c.applications, 2, 'Contact Info', '@changed');
  f.edit(c.applications, 2, 'publication_order', 999);
  f.calls = [];
  const t = fake(f, { idBase: 2000 }), { result } = await t.run();
  assert.equal(result.kind, 'COMPLETED'); assert.equal(result.batch.batch_id, prior.batch_id);
  assert.deepEqual(t.sends.map(s => s.parameters.text.split('\n')[0]), ['...start &gt;&gt;', '·1·', '·2·', '·3·', '...end &gt;&gt;']);
  assert.deepEqual(t.sends[0].parameters, first.sends[0].parameters);
  assertReset(t.sends[0]); assert.deepEqual(frozen(f), before);
  assert.equal(result.batch.start_telegram_message_id, 2000);
  assert.deepEqual(result.batch.items.map(i => i.telegram_message_id), [2001, 2002, 2003]);
  const reset = f.calls.find(call => call.method === 'POST').requests;
  assert.equal(reset.length, 7 + 3 * 7, 'one commit resets seven batch fields and seven fields per vacancy');
  assert.ok(reset.every(r => r.updateCells), 'no sheet creation/deletion or snapshot append');
});
test('fresh CREATED commit only changes batch state/diagnostics and starts at zero', async () => {
  const f = ready(), t = fake(f), before = frozen(f);
  f.control(c, true);
  const apps = f.sheet(c.applications); apps.values.push(apps.values[0].map(k => example('later', 40)[k] ?? ''));
  await t.run();
  assert.equal(state(f).batches.length, 1); assert.equal(state(f).control, true);
  assertReset(t.sends[0]); assert.deepEqual(frozen(f), before);
  assert.equal(f.calls.find(x => x.method === 'POST').requests.length, 3);
});
for (const at of [0, 2, 4]) test('crash-stuck PUBLISHING blocks until the documented manual FAILED edit: ' + at, async () => {
  const f = ready(), t = fake(f); let seen = 0;
  await assert.rejects(t.run({ beforeNode: name => {
    if (name === 'Publication Cursor' && seen++ === at) throw new Error('SIMULATED_CRASH');
  } }), /SIMULATED_CRASH/);
  const before = structuredClone(f.sheets); f.calls = [];
  const later = fake(f), result = await later.run();
  assert.equal(result.result.kind, 'BATCH_ALREADY_PUBLISHING');
  assert.deepEqual(later.calls, []); assert.deepEqual(f.sheets, before);
  assert.equal(f.calls.filter(x => x.method === 'POST').length, 0);
  // Operator has checked the n8n UI and cleaned Telegram before this manual edit.
  f.edit(c.batches, 2, 'batch_status', 'FAILED');
  const retry = fake(f, { idBase: 2000 }); await retry.run();
  assert.equal(retry.sends.length, 5); assertReset(retry.sends[0]);
});
test('second publish started during an active attempt returns BATCH_ALREADY_PUBLISHING', async () => {
  const f = ready(), first = fake(f); let checked = false;
  await first.run({ beforeNode: async name => {
    if (name === 'Publication Cursor' && !checked) {
      checked = true;
      const before = structuredClone(f.sheets), other = fake(f);
      assert.equal((await other.run()).result.kind, 'BATCH_ALREADY_PUBLISHING');
      assert.deepEqual(other.calls, []); assert.deepEqual(f.sheets, before);
    }
  } });
  assert.equal(first.sends.length, 5);
});
for (const afterEndCrash of [false, true]) test('completed rerun preserves history, crash=' + afterEndCrash, async () => {
  const f = ready(), t = fake(f);
  if (afterEndCrash) await assert.rejects(t.run({ beforeNode: name => { if (name === 'Publication Completed') throw new Error('CRASH'); } }), /CRASH/);
  else await t.run();
  f.control(c, false);
  const before = structuredClone(f.sheets); f.calls = [];
  const later = fake(f), result = await later.run();
  assert.equal(result.result.kind, 'INACTIVE');
  assert.deepEqual(later.calls, []); assert.deepEqual(f.sheets, before);
  assert.equal(f.calls.filter(x => x.method === 'POST').length, 0);
});
test('FAILED retries the same batch even with creation checkbox checked', async () => {
  const { f } = await stopped(2), before = frozen(f); f.control(c, true);
  const result = await fake(f).run();
  assert.equal(result.result.kind, 'COMPLETED'); assert.equal(result.result.batch.batch_status, 'COMPLETED');
  assert.deepEqual(frozen(f), before); assert.equal(state(f).batches.length, 1);
});
for (const [label, options, mutate] of [
  ['wrong channel', { chat: { ok: true, result: { id: -100777, type: 'channel' } } }],
  ['wrong bot', { admins: [{ status: 'administrator', can_post_messages: true, user: { id: 333, is_bot: true } }] }],
  ['permission', { admins: [{ status: 'administrator', can_post_messages: false, user: { id: 222, is_bot: true } }] }],
  ['invalid config', { env: { WORKFLOW_B_TELEGRAM_CHAT_ID: '@wrong' } }],
  ['last payload too long', {}, f => {
    const item = { ...state(f).active.items[2], contact: 'x'.repeat(4096) };
    f.edit(c.items, 4, 'contact', item.contact); f.edit(c.items, 4, 'rendered_text', renderVacancy(item));
  }],
  ['frozen render mismatch', {}, f => f.edit(c.items, 4, 'rendered_text', 'broken')],
  ['source row moved', {}, f => f.sheet(c.applications).values.reverse()],
  ['application ID', {}, f => f.edit(c.applications, 2, 'application_id', 'wrong')],
  ['batch association', {}, f => f.edit(c.applications, 2, 'batch_id', 'wrong')],
  ['position association', {}, f => f.edit(c.applications, 2, 'batch_position', 99)],
]) test('FAILED preflight preserves all prior delivery evidence and sends nothing: ' + label, async () => {
  const { f } = await stopped(3); mutate?.(f); const before = structuredClone(f.sheets); f.calls = [];
  const t = fake(f, options); await assert.rejects(t.run());
  assert.equal(t.sends.length, 0); assert.deepEqual(f.sheets, before);
  assert.equal(f.calls.filter(x => x.method === 'POST').length, 0);
});
test('retry clears even non-prefix old evidence; it never calculates a restart position', async () => {
  const { f } = await stopped(4);
  for (const key of delivery) f.edit(c.items, 2, key, '');
  f.edit(c.items, 2, 'item_state', 'NOT_SENT');
  f.edit(c.batches, 2, 'completed_at', stamp); f.edit(c.batches, 2, 'end_telegram_message_id', 9000);
  const t = fake(f, { idBase: 2000 }); await t.run(); assertReset(t.sends[0]); assert.equal(t.sends.length, 5);
});
for (const committed of [false, true]) test('retry reset committed=' + committed + ' without confirmation sends nothing', async () => {
  const { f } = await stopped(3), before = structuredClone(f.sheets), t = fake(f);
  if (committed) f.failAfterCommit = true; else f.failBeforeCommit = true;
  await assert.rejects(t.run(), /UNCONFIRMED_PUBLICATION_WRITE/); assert.equal(t.sends.length, 0);
  if (committed) {
    assert.equal(state(f).active.batch_status, 'PUBLISHING');
    assert.equal((await fake(f).run()).result.kind, 'BATCH_ALREADY_PUBLISHING');
  } else { assert.deepEqual(f.sheets, before); assert.equal(state(f).active.batch_status, 'FAILED'); }
});
for (const at of [0, 2, 4]) for (const committed of [false, true]) test('uncertain ack write at ' + at + ', committed=' + committed + ' stops without erasing delivery evidence', async () => {
  const f = ready(), t = fake(f); let seen = 0;
  await assert.rejects(t.run({ beforeNode: name => {
    if (name === 'Persist Telegram Acknowledgement' && seen++ === at) {
      if (committed) f.failAfterCommit = true; else f.failBeforeCommit = true;
    }
  } }), committed && at === 4 ? /PUBLICATION_ALREADY_COMPLETED/ : /UNCONFIRMED_PUBLICATION_WRITE/);
  assert.equal(t.sends.length, at + 1);
  const s = state(f), later = fake(f, { idBase: 2000 });
  if (committed && at === 4) {
    assert.equal(s.active, null); const before = structuredClone(f.sheets);
    assert.equal((await later.run()).result.kind, 'INACTIVE'); assert.deepEqual(f.sheets, before);
  } else {
    assert.equal(s.active.batch_status, 'FAILED');
    assert.equal(s.items.filter(i => i.item_state === 'SENT').length, Math.max(0, Math.min(3, at - 1 + Number(committed))));
    await later.run(); assert.equal(later.sends.length, 5); assertReset(later.sends[0]);
  }
});
for (const code of [400, 401, 403, 404, 429, 500]) test('Telegram ' + code + ' stops at vacancy 2 with no wait or automatic retry', async () => {
  const f = ready(), t = fake(f, { responses: { 2: { ok: false, error_code: code, description: 'Rejected', parameters: { retry_after: 17 } } } });
  await assert.rejects(t.run(), /FAILED/); assert.equal(t.sends.length, 3);
  assert.equal(state(f).active.last_publication_error, 'TELEGRAM_REJECTED_' + code);
  assert.equal(state(f).active.items[0].item_state, 'SENT');
});
for (const response of [{}, { error: '429 Too Many Requests: retry_after=17' },
  { ok: false, error_code: 429, parameters: { retry_after: 17 } },
  { ok: true, error_code: 429, description: 'conflicting', parameters: { retry_after: 17 } },
  { ok: false, error_code: 429, description: 'conflicting', result: { message_id: 123 } }]) {
  test('uncertain Telegram response requires cleanup: ' + JSON.stringify(response), async () => {
    const f = ready(), t = fake(f, { responses: { 2: response } });
    await assert.rejects(t.run(), /FAILED/); assert.equal(t.sends.length, 3);
    assert.match(state(f).active.diagnostic_or_unknown_state_note, /manual Telegram cleanup/);
  });
}
test('failed stop persistence leaves PUBLISHING blocked for manual recovery', async () => {
  const f = ready(), t = fake(f, { failAt: 2 });
  await assert.rejects(t.run({ beforeNode: name => { if (name === 'Persist Publication Stop') f.failBeforeCommit = true; } }), /STOP_WRITE_UNCONFIRMED/);
  const later = fake(f); assert.equal((await later.run()).result.kind, 'BATCH_ALREADY_PUBLISHING'); assert.equal(later.sends.length, 0);
});
test('obsolete publisher sheet and old control content are ignored through setup and unified run', async () => {
  const f = new SheetFixture();
  f.sheets.push({ properties: { sheetId: 99, title: '_Workflow B Publisher', hidden: true,
    gridProperties: { rowCount: 1, columnCount: 1 } }, values: [['unparseable obsolete data']] });
  const obsolete = structuredClone(f.sheets[1]);
  f.commit(setupPlan(c, f.metadata(), f.sheet(c.applications).values).requests);
  f.edit(c.applications, 2, 'human_decision', 'PUBLISH'); f.edit(c.applications, 2, 'publication_order', 10);
  f.control(c, true); f.sheet(c.control).values[3] = ['Unused legacy label', '{invalid'];
  await fake(f).run();
  assert.deepEqual(f.sheet('_Workflow B Publisher'), obsolete);
  assert.deepEqual(f.sheet(c.control).values[3], ['Unused legacy label', '{invalid']);
  assert.ok(f.calls.filter(x => x.method === 'GET').every(x => !decodeURIComponent(x.url).includes('_Workflow B Publisher') && !decodeURIComponent(x.url).includes('!B4')));
});
test('new batch after completion preserves completed history', async () => {
  const f = ready(); await fake(f).run(); const history = structuredClone(state(f));
  const app = f.sheet(c.applications), row = example('next', 40);
  app.values.push(app.values[0].map(k => row[k] ?? '')); f.control(c, true);
  f.commit(newBatchPlan(c, f.metadata(), state(f), app.values, randomUUID(), stamp).requests);
  await fake(f, { idBase: 2000 }).run();
  assert.deepEqual(state(f).batches[0], history.batches[0]); assert.deepEqual(state(f).items.slice(0, 3), history.items);
});
test('generated graph has only batch UUID, no self API, no wait and no removed runtime dependencies', () => {
  assert.equal(workflow.active, false);
  assert.ok(workflow.nodes.every(n => !['n8n-nodes-base.n8n', 'n8n-nodes-base.wait'].includes(n.type)));
  assert.deepEqual(workflow.nodes.filter(n => n.type.endsWith('.crypto')).map(n => n.name), ['Generate Batch UUID']);
  const obsolete = /publisherRecord|previous_owner|owner_id|execution_id|ownerWrite|confirmPreviousPublisherStopped|refreshPublicationAfterStop|PUBLISHER_OWNERSHIP_CONFLICT|acknowledgedCursor|WORKFLOW_B_PUBLISHER_TAB|N8N_API_CREDENTIAL|n8nApi|retry_after|generated_owner/;
  assert.doesNotMatch(JSON.stringify(workflow), obsolete);
  assert.doesNotMatch(readFileSync(new URL('./workflow-b.env.example', import.meta.url), 'utf8'), obsolete);
  const reachable = new Set();
  const visit = name => { if (reachable.has(name)) return; reachable.add(name); for (const edge of workflow.connections[name]?.main.flat() ?? []) visit(edge.node); };
  visit('Manual Trigger'); assert.equal(reachable.size, workflow.nodes.length);
});

test('unreadable batch after uncertain acknowledgement write stops for manual inspection', async () => {
  const f = ready(), t = fake(f); let seen = 0;
  await assert.rejects(t.run({ beforeNode: name => {
    if (name === 'Persist Telegram Acknowledgement' && seen++ === 2) f.failBeforeCommit = true;
    if (name === 'Read Batch After Unconfirmed Write') throw new Error('SHEETS_UNAVAILABLE');
  } }), /SHEETS_UNAVAILABLE/);
  assert.equal(t.sends.length, 3); assert.equal(state(f).active.batch_status, 'PUBLISHING');
  const later = fake(f); assert.equal((await later.run()).result.kind, 'BATCH_ALREADY_PUBLISHING');
  assert.equal(later.sends.length, 0);
});
test('legacy publisher environment configuration is ignored even when invalid', () => {
  const configured = sheetsConfig({ ...env, WORKFLOW_B_PUBLISHER_TAB: 'invalid/tab' });
  assert.deepEqual(configured, c); assert.equal(Object.hasOwn(configured, 'publisher'), false);
});
