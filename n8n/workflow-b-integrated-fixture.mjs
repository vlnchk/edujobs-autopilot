// M5 scenarios reuse the generated-graph harness and Sheets model. External
// cleanup is a test prerequisite, never an operation available to the workflow.
import assert from 'node:assert/strict';
import { SheetFixture, example, runGraph } from './workflow-b-sheets-fixture.mjs';
import { sheetsConfig, table, projectionRows, projectionFormula, ITEM_FIELDS, persistenceState, readPlan, newBatchPlan } from './workflow-b-sheets.mjs';

export async function verifyIntegratedWorkflow(workflow, runtime = {}) {
  const env = { GOOGLE_SHEETS_DOCUMENT_ID: 'synthetic-m5-sheet',
    WORKFLOW_B_TELEGRAM_CHAT_ID: '-1001234567890', WORKFLOW_B_TELEGRAM_EXPECTED_BOT_ID: '222' };
  const c = sheetsConfig(env), visited = new Set(), branches = new Set();
  const hooks = { ...runtime, beforeNode: async (name, input) => {
    visited.add(name); await runtime.beforeNode?.(name, input);
  }, afterNode: (name, branch) => branches.add(`${name}:${branch}`) };
  const records = (f, title) => table(f.sheet(title).values).rows;
  const writes = f => f.calls.filter(x => x.method === 'POST');
  const frozen = f => records(f, c.items).map(row => Object.fromEntries(ITEM_FIELDS
    .filter(k => !['item_state', 'telegram_message_id', 'telegram_message_url', 'published_at'].includes(k))
    .map(k => [k, row[k]])));
  let executions = 0;
  const run = (f, transport, extra = {}, mode = 'run', latest) => {
    executions++;
    return runGraph(workflow, f, { ...env, WORKFLOW_B_MODE: mode }, latest, transport,
      { ...hooks, ...extra, beforeNode: async (name, input) => {
        await hooks.beforeNode(name, input); await extra.beforeNode?.(name, input);
      } });
  };
  const ready = async (rows = [example()]) => {
    const f = new SheetFixture(rows);
    assert.equal((await run(f, undefined, {}, 'setup')).result.kind, 'SETUP_COMPLETE');
    for (const [title, archive] of [[c.review, false], [c.archive, true]])
      assert.equal(f.sheet(title).values[0][0], projectionFormula(c, f.sheet(c.applications).values[0], archive));
    rows.forEach((row, i) => { for (const k of ['human_decision', 'publication_order']) f.edit(c.applications, i + 2, k, row[k]); });
    return f;
  };
  const fake = (f, options = {}) => {
    const sends = [], calls = [], visible = [];
    return { sends, calls, visible, transport: async (_, p) => {
      calls.push(p.operation);
      if (p.operation === 'get') return [{ ok: true, result: { id: options.wrongDestination ? -100999 : Number(env.WORKFLOW_B_TELEGRAM_CHAT_ID), type: 'channel' } }];
      if (p.operation === 'administrators') return [{ status: 'administrator', can_post_messages: true, user: { id: 222, is_bot: true } }];
      assert.equal(p.operation, 'sendMessage');
      assert.deepEqual(p.additionalFields, { parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: false, appendAttribution: false });
      const batch = records(f, c.batches).find(b => b.batch_status !== 'COMPLETED');
      assert.equal(batch.batch_status, 'PUBLISHING');
      if (sends.length) assert.equal(batch.start_telegram_message_id, options.idBase ?? 100);
      for (let i = 1; i < sends.length; i++) {
        const item = records(f, c.items).find(r => r.batch_id === batch.batch_id && r.batch_position === i);
        const app = records(f, c.applications).find(r => r.application_id === item.application_id);
        assert.equal(item.telegram_message_id, (options.idBase ?? 100) + i);
        assert.equal(app.telegram_message_id, item.telegram_message_id);
      }
      sends.push(p.text); visible.push(p.text);
      if (sends.length - 1 === options.failAt) throw Error('synthetic uncertain acknowledgement');
      return [{ ok: true, result: { message_id: (options.idBase ?? 100) + sends.length - 1, date: 1789800000 + sends.length,
        chat: { id: Number(env.WORKFLOW_B_TELEGRAM_CHAT_ID), type: 'channel' } } }];
    } };
  };
  // Fresh single/multi batches go from checkbox through END in ONE run.
  for (const count of [1, 3]) {
    const rows = [...Array.from({ length: count }, (_, i) => ({ ...example(`approved-${i}`, (i + 1) * 10),
      processing_status: i ? 'ERROR' : 'UNKNOWN_FUTURE_STATUS' })),
      { ...example('rejected'), human_decision: 'REJECT' }, { ...example('unresolved'), human_decision: '' }];
    const f = await ready(rows), t = fake(f);
    const before = structuredClone(f.sheets), writeCount = writes(f).length;
    assert.equal((await run(f, t.transport)).result.kind, 'INACTIVE');
    assert.deepEqual(f.sheets, before); assert.equal(writes(f).length, writeCount); assert.deepEqual(t.calls, []);
    f.control(c, true);
    let creationId, immutable;
    const result = await run(f, t.transport, { beforeNode: (name, input) => {
      if (name === 'Prepare Whole Frozen Transport') {
        creationId = input[0].batch.batch_id; immutable = frozen(f);
        // A later approval must wait for a new execution and checkbox action.
        f.edit(c.applications, count + 3, 'human_decision', 'PUBLISH');
        f.edit(c.applications, 2, 'draft_description', 'Edited after freezing');
        f.edit(c.applications, 2, 'Project Website Link', 'https://changed.test');
      }
    } }, 'run', () => {
      f.edit(c.applications, 2, 'draft_description', 'Latest <b>literal</b> & *plain*');
      f.edit(c.applications, 2, 'project_link_text', 'Latest');
      f.edit(c.applications, 2, 'publication_order', 100);
      f.edit(c.applications, 2, 'Original Link', 'https://Example.test/a%2Fb?x=1&x=2&empty=#Frag');
      f.edit(c.applications, 2, 'Contact Info', '<editor> & team');
    });
    assert.equal(result.result.kind, 'COMPLETED'); assert.equal(result.result.batch.batch_id, creationId);
    assert.equal(result.result.batch.vacancy_count, count); assert.equal(records(f, c.batches).length, 1);
    assert.deepEqual(t.sends.map(s => s.split('\n')[0]), ['...start &gt;&gt;', ...Array.from({ length: count }, (_, i) => `·${i + 1}·`), '...end &gt;&gt;']);
    assert.match(t.sends.at(-2), />Latest<\/a> &lt;b&gt;literal&lt;\/b&gt; &amp; \*plain\*/);
    assert.ok(t.sends.at(-2).includes('href="https://Example.test/a%2Fb?x=1&amp;x=2&amp;empty=#Frag"'));
    assert.deepEqual(frozen(f), immutable);
    const views = projectionRows(records(f, c.applications));
    assert.deepEqual(views.review.map(r => r.application_id), ['unresolved']); assert.equal(views.archive.length, count + 1);
    for (const [i, row] of rows.entries()) for (const key of ['application_id', 'processing_status', 'primary_reason', 'review_reason', 'final_description'])
      assert.equal(records(f, c.applications)[i][key], row[key]);
    const completed = structuredClone(f.sheets), totalWrites = writes(f).length;
    assert.equal((await run(f, t.transport)).result.kind, 'INACTIVE');
    assert.deepEqual(f.sheets, completed); assert.equal(writes(f).length, totalWrites); assert.equal(t.sends.length, count + 2);
    f.control(c, true);
    const next = fake(f, { idBase: 200 });
    const later = await run(f, next.transport);
    assert.equal(later.result.kind, 'COMPLETED'); assert.notEqual(later.result.batch.batch_id, creationId);
    assert.deepEqual(f.sheet(c.batches).values[1], completed.find(s => s.properties.title === c.batches).values[1]);
    assert.deepEqual(f.sheet(c.items).values.slice(1, count + 1), completed.find(s => s.properties.title === c.items).values.slice(1));
  }
  // A post-creation destination failure preserves CREATED; future runs use the snapshot.
  const f = await ready([example('a', 10), example('b', 20)]);
  f.control(c, true);
  const bad = fake(f, { wrongDestination: true });
  await assert.rejects(run(f, bad.transport), /DESTINATION_MISMATCH/);
  assert.equal(records(f, c.batches)[0].batch_status, 'CREATED'); assert.deepEqual(bad.sends, []);
  const created = structuredClone(f.sheets), immutable = frozen(f), batchId = records(f, c.batches)[0].batch_id;
  await assert.rejects(run(f, bad.transport), /DESTINATION_MISMATCH/); assert.deepEqual(f.sheets, created);
  f.edit(c.applications, 2, 'draft_description', 'Changed after freezing'); f.edit(c.applications, 2, 'Contact Info', 'Changed');
  const failed = fake(f, { failAt: 2 });
  await assert.rejects(run(f, failed.transport), /FAILED/);
  assert.equal(failed.sends.length, 3); assert.equal(records(f, c.batches)[0].batch_status, 'FAILED');
  const evidence = structuredClone(f.sheets), beforeRetryWrites = writes(f).length;
  await assert.rejects(run(f, bad.transport), /DESTINATION_MISMATCH/);
  assert.deepEqual(f.sheets, evidence); assert.equal(writes(f).length, beforeRetryWrites);
  // External operator cleanup, explicitly modeled outside the workflow.
  failed.visible.length = 0;
  assert.equal(failed.visible.length, 0);
  f.control(c, true); // Existing batch wins; finishing it cannot fall through to creation.
  f.sheet(c.applications).values.push(f.sheet(c.applications).values[0].map(h => example('later', 30)[h] ?? ''));
  const retry = fake(f, { idBase: 300 });
  const retried = await run(f, retry.transport);
  assert.equal(retried.result.batch.batch_id, batchId); assert.equal(retried.result.kind, 'COMPLETED');
  assert.deepEqual(retry.sends.slice(0, 3), failed.sends); assert.equal(retry.sends.length, 4);
  assert.deepEqual(frozen(f), immutable); assert.equal(records(f, c.batches).length, 1);
  assert.equal(writes(f)[beforeRetryWrites].requests.length, 7 + 2 * 7);
  assert.equal(f.sheet(c.control).values[1][1], true);
  // PUBLISHING is an absolute no-op even with checked control and invalid transport env.
  f.edit(c.batches, 2, 'batch_status', 'PUBLISHING');
  const stuck = structuredClone(f.sheets), noCalls = fake(f), stuckWrites = writes(f).length;
  const channelId = env.WORKFLOW_B_TELEGRAM_CHAT_ID; env.WORKFLOW_B_TELEGRAM_CHAT_ID = '';
  assert.equal((await run(f, noCalls.transport)).result.kind, 'BATCH_ALREADY_PUBLISHING');
  assert.deepEqual(f.sheets, stuck); assert.deepEqual(noCalls.calls, []); assert.equal(writes(f).length, stuckWrites);
  env.WORKFLOW_B_TELEGRAM_CHAT_ID = channelId;
  // Stop after an unconfirmed acknowledgement, including the failure persistence path.
  const uncertain = await ready(); uncertain.control(c, true); const t = fake(uncertain);
  await assert.rejects(run(uncertain, t.transport, { beforeNode: name => {
    if (name === 'Persist Telegram Acknowledgement') uncertain.failBeforeCommit = true;
  } }), /UNCONFIRMED_PUBLICATION_WRITE/);
  assert.equal(t.sends.length, 1);
  // Preserve creation claim/read-back safeguards in the shared runtime harness.
  for (const outcome of ['lost-response', 'uncommitted', 'unreadable', 'incomplete', 'other-winner']) {
    const claimed = await ready(); claimed.control(c, true); const transport = fake(claimed);
    let plannedId;
    const extra = { beforeNode: (name, input) => {
      if (name === 'Atomic Sheets Commit') {
        plannedId = input[0].batch.batch_id;
        if (outcome === 'lost-response') claimed.failAfterCommit = true;
        if (outcome === 'uncommitted') claimed.failBeforeCommit = true;
        if (outcome === 'other-winner') {
          // Another execution commits its atomic claim before our cached plan.
          const winner = newBatchPlan(c, claimed.metadata(), persistenceState(c, claimed.metadata(),
            claimed.get(readPlan(c, claimed.metadata()).url)), claimed.sheet(c.applications).values,
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-09-23T00:00:00Z');
          claimed.commit(winner.requests);
        }
      }
      if (name === 'Prepare Whole Frozen Transport' && outcome === 'lost-response') {
        assert.equal(input[0].publication_confirmed, true); assert.equal(input[0].recovered_after_write_error, true);
        assert.equal(input[0].batch.batch_id, plannedId);
      }
      if (name === 'Read Persistence After Commit') {
        if (outcome === 'unreadable') throw Error('SIMULATED_READ_FAILURE');
        if (outcome === 'incomplete') claimed.sheet(c.items).values.pop();
      }
    } };
    if (['uncommitted', 'unreadable', 'incomplete'].includes(outcome)) {
      await assert.rejects(run(claimed, transport.transport, extra), /UNCONFIRMED_SHEETS_WRITE|SIMULATED_READ_FAILURE|INCOMPLETE_SNAPSHOT_COUNT/);
      assert.deepEqual(transport.calls, []);
    } else {
      const result = await run(claimed, transport.transport, extra);
      if (outcome === 'lost-response') {
        assert.equal(result.result.kind, 'COMPLETED'); assert.equal(result.result.batch.batch_id, plannedId);
        assert.equal(transport.sends.length, 3);
      } else {
        assert.equal(result.result.kind, 'ACTIVE_BATCH'); assert.equal(result.result.overlapping_winner, true);
        assert.equal(result.result.publication_confirmed, false); assert.notEqual(result.result.batch.batch_id, plannedId);
        assert.deepEqual(transport.calls, []); assert.equal(records(claimed, c.batches).length, 1);
        assert.equal(result.visited.includes('Prepare Whole Frozen Transport'), false);
      }
    }
  }
  // Empty and invalid selections never enter transport; only empty consumes control.
  const empty = await ready([{ ...example(), human_decision: '' }]); empty.control(c, true);
  assert.equal((await run(empty)).result.kind, 'NO_CANDIDATES'); assert.equal(records(empty, c.batches).length, 0);
  empty.edit(c.applications, 2, 'human_decision', 'PUBLISH'); empty.edit(c.applications, 2, 'publication_order', ''); empty.control(c, true);
  const beforeInvalid = structuredClone(empty.sheets), invalid = await run(empty);
  assert.equal(invalid.result.kind, 'PREFLIGHT_FAILED'); assert.deepEqual(empty.sheets, beforeInvalid);
  const codeNames = workflow.nodes.filter(n => n.type.endsWith('.code')).map(n => n.name);
  assert.deepEqual(codeNames.filter(name => !visited.has(name)), [], 'every generated Code node exercised');
  for (const node of workflow.nodes.filter(n => n.type.endsWith('.if')))
    for (const branch of [0, 1]) assert.ok(branches.has(`${node.name}:${branch}`), `${node.name} branch ${branch}`);
  return { executions, generated_code_nodes: codeNames.length, visited_nodes: visited.size,
    if_branches: workflow.nodes.filter(n => n.type.endsWith('.if')).length * 2,
    external_services: 'mocked', google_formula_execution: false, operator_cleanup: 'external prerequisite modeled' };
}

// Also run in the installed hardened sandbox, using identical generated Code.
export async function verifyHyperlinkWorkflow(workflow, runtime = {}) {
  const env = { GOOGLE_SHEETS_DOCUMENT_ID: 'synthetic-links', WORKFLOW_B_MODE: 'run',
    WORKFLOW_B_TELEGRAM_CHAT_ID: '-1001234567890', WORKFLOW_B_TELEGRAM_EXPECTED_BOT_ID: '222' };
  const c = sheetsConfig(env), f = new SheetFixture([example('first', 10), { ...example('second', 20), draft_description: '!Approved\\', project_link_text: 'Approved\\' }]);
  const run = (mode, beforeLatest, telegram) => runGraph(workflow, f, { ...env, WORKFLOW_B_MODE: mode }, beforeLatest, telegram, runtime);
  await run('setup');
  for (let row = 2; row <= 3; row++) {
    f.edit(c.applications, row, 'human_decision', 'PUBLISH'); f.edit(c.applications, row, 'publication_order', (row - 1) * 10);
  }
  f.control(c, true);
  const destination = 'https://museum.test/a(b(c))?x=1&x=2&empty=&q="yes"#F';
  const draft = String.raw`Музей [«Коллекция»](https://old.test/a(b)) ищет медиатора. «Коллекция» <b>буквально</b> \[скобки\] \\ [Другой](https://other.test/x(y)?a=1\&b=2)`
    + '\nЗадачи:\n* Звонить.\n- Работать с [лидами](https://leads.test/a(b)?x=1&x=2).\n  Продолжение.\n• Передавать заявки.';
  const contact = 'WhatsApp:\u00a0+62 811 1234 5678  Telegram:\u00a0@Example_HR';
  const secondContact = 'm.recruiter@example.org\u00a0 / ТГ @recruiter_hr Галина ';
  await assert.rejects(run('run', () => {
    f.edit(c.applications, 2, 'draft_description', draft);
    f.edit(c.applications, 2, 'project_link_text', '«Коллекция»');
    f.edit(c.applications, 2, 'Project Website Link', destination);
    f.edit(c.applications, 2, 'Contact Info', contact);
    f.edit(c.applications, 3, 'Contact Info', secondContact);
  }, async () => [{ ok: false }]), /DESTINATION_MISMATCH/);
  const batch = persistenceState(c, f.metadata(), f.get(readPlan(c, f.metadata()).url)).active, item = batch.items[0];
  assert.equal(batch.batch_status, 'CREATED');
  assert.equal(item.draft_description, draft); assert.equal(item.project_link_text, '«Коллекция»');
  assert.equal(item.project_link, destination); assert.equal(item.snapshot_version, 'presentation-v5');
  assert.equal(item.contact, contact);
  assert.equal(batch.items[1].contact, secondContact);
  assert.equal(batch.items[1].publication_contact, 'm.recruiter@example.org | @recruiter_hr Галина');
  assert.equal(item.publication_contact, 'WhatsApp +62 811 1234 5678 | @Example_HR');
  assert.ok(item.publication_description.includes('[«Коллекция»](https://museum.test/a\\(b\\(c\\)\\)?x=1\\&x=2\\&empty=\\&q="yes"#F)'));
  assert.equal(f.sheet(c.applications).values[1][f.sheet(c.applications).values[0].indexOf('draft_description')], draft);
  assert.equal(f.sheet(c.applications).values[1][f.sheet(c.applications).values[0].indexOf('Contact Info')], contact);
  f.edit(c.applications, 2, 'draft_description', 'Changed after freezing');
  f.edit(c.applications, 2, 'project_link_text', 'Changed'); f.edit(c.applications, 2, 'Project Website Link', 'https://later.test');
  f.edit(c.applications, 2, 'Contact Info', 'Phone: +99 888 777');
  const apps = structuredClone(f.sheet(c.applications).values), sends = [];
  let fail = true, ackId = 100, calls = 0;
  const telegram = async (_, p) => {
    calls++;
    if (p.operation === 'get') return [{ ok: true, result: { id: Number(env.WORKFLOW_B_TELEGRAM_CHAT_ID), type: 'channel' } }];
    if (p.operation === 'administrators') return [{ status: 'administrator', can_post_messages: true, user: { id: 222, is_bot: true } }];
    assert.equal(p.operation, 'sendMessage'); sends.push(p.text);
    if (fail && sends.length === 3) throw Error('synthetic uncertain delivery');
    return [{ ok: true, result: { message_id: ackId++, date: 1789862400,
      chat: { id: Number(env.WORKFLOW_B_TELEGRAM_CHAT_ID), type: 'channel' } } }];
  };
  await assert.rejects(run('run', undefined, telegram), /FAILED/);
  assert.equal(sends.length, 3);
  const expectedBody = 'Музей <a href="https://museum.test/a(b(c))?x=1&amp;x=2&amp;empty=&amp;q=&quot;yes&quot;#F">«Коллекция»</a> ищет медиатора. «Коллекция» &lt;b&gt;буквально&lt;/b&gt; [скобки] \\ <a href="https://other.test/x(y)?a=1&amp;b=2">Другой</a>';
  assert.ok(sends[1].includes(expectedBody), sends[1]);
  assert.ok(sends[1].includes('\nЗадачи:\n• Звонить.\n• Работать с <a href="https://leads.test/a(b)?x=1&amp;x=2">лидами</a>.\n  Продолжение.\n• Передавать заявки.'));
  assert.ok(sends[1].endsWith('\n\nКонтакт: WhatsApp +62 811 1234 5678 | @Example_HR'));
  assert.equal(sends[1].includes('https://later.test'), false);
  assert.ok(sends[2].endsWith('\n\nКонтакт: m.recruiter@example.org | @recruiter_hr Галина'));
  for (const text of sends.slice(1)) {
    assert.equal((text.match(/Контакт:/g) ?? []).length, 1);
    assert.equal(/\\[@_]/.test(text), false);
  }
  assert.ok(sends[2].includes('!<a href="https://project.example">Approved\\</a>'));
  // Corrupt frozen metadata fails before reset, destination checks or sends.
  for (const [key, changed] of [['project_link', 'https://tampered.test'], ['publication_contact', 'Telegram @Changed'], ['publication_description', 'Changed']]) {
    f.edit(c.items, 2, key, changed);
    const evidence = structuredClone(f.sheets), previousCalls = calls, writes = f.calls.filter(x => x.method === 'POST').length;
    await assert.rejects(run('run', undefined, telegram), /INCOMPLETE_SNAPSHOT_CONTENT/);
    assert.deepEqual(f.sheets, evidence); assert.equal(calls, previousCalls);
    assert.equal(f.calls.filter(x => x.method === 'POST').length, writes);
    f.edit(c.items, 2, key, item[key]);
  }
  // Restore the fixture's known frozen evidence. Simulate external operator cleanup.
  fail = false;
  const result = await run('run', undefined, telegram);
  assert.equal(result.result.kind, 'COMPLETED'); assert.equal(result.result.batch.batch_id, batch.batch_id);
  assert.deepEqual(sends.slice(0, 3), sends.slice(3, 6)); assert.equal(sends.length, 7);
  for (let i = 0; i < batch.items.length; i++) for (const key of ITEM_FIELDS.filter(k => !['item_state', 'telegram_message_id', 'telegram_message_url', 'published_at'].includes(k)))
    assert.equal(result.result.batch.items[i][key], batch.items[i][key], key);
  const current = f.sheet(c.applications).values;
  for (let row = 1; row < current.length; row++) for (const [column, header] of current[0].entries())
    if (!['telegram_message_id', 'telegram_message_url', 'published_at'].includes(header)) assert.equal(current[row][column], apps[row][column]);
  assert.equal((await run('run', undefined, telegram)).result.kind, 'INACTIVE');
  assert.equal(sends.length, 7);
  return { executions: 8, live_api_calls: 0, latest_links_frozen: true, list_contact_presentation_frozen: true, full_retry_identical: true };
}
