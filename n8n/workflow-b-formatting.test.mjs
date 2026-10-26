import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatUnorderedLists, formatContact, formatContactV4, preflightNewBatch, renderProjectBody, parseInlineLinks,
  renderVacancy, frozenVacancyTransport, snapshotFormat, PROJECT_LINK_FIELDS, PRESENTATION_FIELDS,
  PROJECT_LINK_SNAPSHOT_VERSION, PRESENTATION_SNAPSHOT_VERSION } from './workflow-b-domain.mjs';
import { sheetsConfig, table, setupPlan, readPlan, persistenceState, reconstructBatch,
  LEGACY_ITEM_FIELDS } from './workflow-b-sheets.mjs';
import { example, SheetFixture, runGraph, bundledDomain } from './workflow-b-sheets-fixture.mjs';
import { visibleLength } from '../workflow-logic/publication-shape.mjs';
import { verifyHyperlinkWorkflow } from './workflow-b-integrated-fixture.mjs';

// presentation-v5 omits the redundant Telegram label; v4 and earlier keep it.
const requestedContact = 'WhatsApp +62 811 1234 5678 | @Example_HR';
const requestedContactV4 = 'WhatsApp +62 811 1234 5678 | Telegram @Example_HR';
const rawContact = String.raw`Контакт: WhatsApp: +62 811 1234 5678; Telegram: @Example\_HR`;
const candidate = change => ({ application_id: 'formatting', row_number: 2, human_decision: 'PUBLISH',
  publication_order: 10, successfully_published: false, active_unfinished_batch_id: null,
  draft_description: '[Ксамата](https://project-site.com/) — компания.\nЗадачи:\n* Звонить.\n- Передавать лиды.',
  project_link_text: 'Ксамата', project_link: 'https://project-site.com/',
  details_link: 'https://vacancy.test/job?x=1&x=2', contact: rawContact, ...change });
const prepared = change => {
  const result = preflightNewBatch([candidate(change)]);
  assert.equal(result.ok, true, JSON.stringify(result)); return result.items[0];
};

for (const marker of ['*', '-', '–', '—', '•']) test('colon-introduced list marker ' + marker, () => {
  const source = 'Задачи:\n  ' + marker + '\t  Первая.\n    Продолжение.\n  ' + marker + ' Вторая.';
  const expected = 'Задачи:\n  • Первая.\n    Продолжение.\n  • Вторая.';
  assert.equal(formatUnorderedLists(source), expected);
  assert.equal(formatUnorderedLists(expected), expected);
});
test('exact mixed-marker example, order and item wording', () => {
  const source = 'Чем предстоит заниматься:\n* Осуществлять исходящие звонки.\n- Проводить первичную квалификацию.\n• Передавать лиды в отдел продаж.';
  assert.equal(formatUnorderedLists(source), 'Чем предстоит заниматься:\n• Осуществлять исходящие звонки.\n• Проводить первичную квалификацию.\n• Передавать лиды в отдел продаж.');
});
test('unheaded mixed/star runs and explicit single bullets are recognized', () => {
  for (const source of ['* Один\n* Два', '- Один\n* Два', '– Один\n• Два', '— Один\n* Два'])
    assert.equal(formatUnorderedLists(source), '• Один\n• Два');
  assert.equal(formatUnorderedLists('•\t  Один'), '• Один');
  assert.equal(formatUnorderedLists('•  10 лет'), '• 10 лет');
});
test('indentation, nested items, continuation lines, numbered lists and line endings survive', () => {
  const source = '\r\nОбязанности:\r\n\t- Первая:  \r\n\t\t* Вложенная.\r\n\t\t  продолжение\r\n\t— Вторая.\r\n\r\n1. Первый\n2) Второй\n';
  const expected = '\r\nОбязанности:\r\n\t• Первая:  \r\n\t\t• Вложенная.\r\n\t\t  продолжение\r\n\t• Вторая.\r\n\r\n1. Первый\n2) Второй\n';
  assert.equal(formatUnorderedLists(source), expected);
  assert.equal(formatUnorderedLists(expected), expected);
  assert.equal(formatUnorderedLists('Задачи:\r- Один\r- Два'), 'Задачи:\r• Один\r• Два');
});
for (const source of [
  '— Привет.\n— Ответ.', '- Один\n- Два', '* Отдельная сноска', '- Отдельная ремарка',
  '*emphasis* и a * b', 'A — B, part-time, x-y', 'Температура:\n-5 градусов\n- 5 градусов\n– 10\n— −10\n* 2 * 3',
  'Раздел:\n* * *\n- - -\n— — —', 'Задачи:\n\n- После пустой строки', '\\* Не маркер',
  '1. Один\n2. Два\n  3) Три', 'Текст\n- Неоднозначно\nОбычный текст\n* Сноска',
]) test('ambiguous/non-list source preserved: ' + JSON.stringify(source), () => {
  assert.equal(formatUnorderedLists(source), source);
});
test('clickable exact project example and unrelated links inside items reuse O-008 HTML', () => {
  const draft = '[Ксамата](https://project-site.com/) — компания.\nЗадачи:\n* [Другая](https://other.test/a(b)?q="x"&x=1&x=2) <b>буквально</b> & "текст"\n- Готово.';
  const item = prepared({ draft_description: draft });
  const result = frozenVacancyTransport(item);
  assert.ok(result.visible.startsWith('·1·\n\nКсамата — компания.\nЗадачи:\n• Другая <b>буквально</b> & "текст"\n• Готово.'));
  assert.ok(result.text.startsWith('·1·\n\n<a href="https://project-site.com/">Ксамата</a> — компания.'));
  assert.ok(result.text.includes('• <a href="https://other.test/a(b)?q=&quot;x&quot;&amp;x=1&amp;x=2">Другая</a> &lt;b&gt;буквально&lt;/b&gt; &amp; &quot;текст&quot;'));
  assert.ok(result.text.includes('Детали: <a href="https://vacancy.test/job?x=1&amp;x=2">vacancy.test/job</a>'));
  assert.equal(result.text.includes('[Ксамата]'), false);
  assert.equal(parseInlineLinks(item.publication_description).spans.find(s => s.text === 'Другая').href,
    'https://other.test/a(b)?q="x"&x=1&x=2');
  assert.equal(item.draft_description, draft);
});
test('markers inside link labels, URLs and project selection are never rewritten', () => {
  const source = 'Список:\n[- Название](https://example.test/—-*)\n* [* метка](https://other.test/a?x=*--)\n- Ещё';
  const item = prepared({ draft_description: source, project_link_text: '- Название', project_link: 'https://example.test/—-*' });
  assert.equal(item.publication_description, 'Список:\n[- Название](https://example.test/—-*)\n• [* метка](https://other.test/a?x=*--)\n• Ещё');
});

for (const separator of [' ', '  ', '\t', ' | ', '|', '; ', ', ', '\n', '\r\n']) test('exact contact example with separator ' + JSON.stringify(separator), () => {
  const source = 'Контакт: WhatsApp: +62 811 1234 5678' + separator + String.raw`Telegram: @Example\_HR`;
  const item = prepared({ contact: source }), transport = frozenVacancyTransport(item);
  assert.equal(item.contact, source); assert.equal(item.publication_contact, requestedContact);
  assert.ok(transport.text.endsWith('\n\nКонтакт: ' + requestedContact));
  assert.equal((transport.text.match(/Контакт:/g) ?? []).length, 1);
  assert.equal(transport.text.includes('\\_'), false);
  assert.equal(formatContact(item.publication_contact), item.publication_contact);
});
for (const [source, expected] of [
  ['WhatsApp: +62 811 1234 5678 / Telegram: @editor', 'WhatsApp +62 811 1234 5678 | Telegram @editor'],
  ['WhatsApp: +62 811 1234 5678 Telegram: @editor обращаться к Анне', 'WhatsApp +62 811 1234 5678 | Telegram @editor обращаться к Анне'],
  ['WhatsApp: +62 811 1234 5678 Telegram: @Example_HR', requestedContactV4],
  ['WhatsApp: +62 811 1234 5678 Telegram: @editor; Email: jobs@example.test', 'WhatsApp +62 811 1234 5678 | Telegram @editor | Email jobs@example.test'],
  ['Telegram: @editor Phone: +7 (999) 123-45-67', 'Telegram @editor | Phone +7 (999) 123-45-67'],
  ['Почта: jobs@example.test Телеграм: @editor', 'Почта jobs@example.test | Телеграм @editor'],
  ['Telegram: @editor (Phone: +1 222)', 'Telegram @editor (Phone: +1 222)'],
  ['WhatsApp: +62 811 1234 5678', 'WhatsApp +62 811 1234 5678'],
  ['Telegram: @Example_HR', 'Telegram @Example_HR'],
  [String.raw`Telegram: @Example\_HR`, 'Telegram @Example_HR'],
  [String.raw`@Example\_HR`, '@Example_HR'],
  ['+62 811 1234 5678', '+62 811 1234 5678'],
  ['Phone: +7 (999) 123-45-67', 'Phone +7 (999) 123-45-67'],
  ['Телефон: 811 1234 5678', 'Телефон 811 1234 5678'],
  ['Telegram: @editor — писать вечером', 'Telegram @editor — писать вечером'],
  ['WhatsApp: +62 811 1234 5678 (Евгения, 10–18)', 'WhatsApp +62 811 1234 5678 (Евгения, 10–18)'],
  ['E-mail: jobs+team@example.test', 'E-mail jobs+team@example.test'],
  ['Почта: jobs@example.test', 'Почта jobs@example.test'],
  ['telegram : @Example_HR', 'telegram @Example_HR'],
  ['Контакт: Контакт: Telegram: @editor', 'Telegram @editor'],
  ['Контакт: Напишите Анне в офис: этаж 2', 'Напишите Анне в офис: этаж 2'],
  ['Telegram: https://t.me/editor?x=1&x=2', 'Telegram https://t.me/editor?x=1&x=2'],
  ['https://example.test/a,b;c|d?x=1&x=2', 'https://example.test/a,b;c|d?x=1&x=2'],
  ['Контакт: ' + requestedContactV4, requestedContactV4],
  ['Email: jobs@example.test; Telegram: @editor; +62 811 1234 5678', 'Email jobs@example.test | Telegram @editor | +62 811 1234 5678'],
]) test('frozen v4 (O-009) contact preserves data: ' + source, () => {
  const value = formatContactV4(source);
  assert.equal(value, expected);
  assert.equal(formatContactV4(value), expected);
  assert.equal(value.replace(/\D/g, ''), source.replace(/\D/g, ''), 'phone digits unchanged');
  if (!source.includes('WhatsApp')) assert.equal(value.includes('WhatsApp'), false);
});
for (const source of [
  'Telegram: @editor, обращаться к Анне, ул. Мира, 12',
  'Telegram: @editor | Неизвестный контакт: кабинет 4',
  'WhatsApp: +62 811 1234 5678 Telegram: unknown',
  'WhatsApp: +62 811 1234 5678 Signal: +1 222',
  'WhatsApp: +62 811 1234 5678 Telegram @editor',
  'Signal: +62 811 1234 5678', 'Офис: ул. Мира, 12',
  String.raw`C:\contacts\_directory; Telegram: @Example\_HR`,
  String.raw`Telegram: @Example\_HR\other`,
  String.raw`Telegram: @Example\\_HR`,
  String.raw`Email: name\_tag@example.test`,
  '[Связаться](https://example.test/contact)', '  Связаться через администратора  ',
]) test('frozen v4 ambiguous contacts remain intact: ' + source, () => {
  assert.equal(formatContactV4(source), source);
  assert.equal(formatContactV4(formatContactV4(source)), source);
});
test('literal HTML and backslashes in contact notes stay escaped literal text', () => {
  const contact = String.raw`Telegram: @Example\_HR (<b>A & "B"</b> C:\notes\_file)`;
  const text = frozenVacancyTransport(prepared({ contact })).text;
  assert.ok(text.endsWith(String.raw`Контакт: @Example_HR (&lt;b&gt;A &amp; &quot;B&quot;&lt;/b&gt; C:\notes\_file)`));
});
for (const [source, expected] of [
  ['https://t.me/Jobdesk1', '@Jobdesk1'], ['t.me/Jobdesk1', '@Jobdesk1'], ['http://www.t.me/Jobdesk1/', '@Jobdesk1'],
  ['https://telegram.me/Some_User', '@Some_User'], ['Telegram: t.me/Jobdesk1', 'Telegram @Jobdesk1'],
  ['ТГ https://t.me/Jobdesk1', 'ТГ @Jobdesk1'], ['Контакт: https://t.me/Jobdesk1, hr@example.test', '@Jobdesk1 | hr@example.test'],
  ['@Ms_example/hiringdesk@school.test', '@Ms_example | hiringdesk@school.test'],
  ['https://t.me/Jobdesk1/hr@example.test', 'https://t.me/Jobdesk1/hr@example.test'],
  ['Ms_example/hiringdesk@school.test', 'Ms_example/hiringdesk@school.test'],
  ['https://t.me/+AbCdEfGh', 'https://t.me/+AbCdEfGh'], ['https://t.me/joinchat/AbCdEfGh', 'https://t.me/joinchat/AbCdEfGh'],
  ['https://t.me/share', 'https://t.me/share'], ['https://t.me/channel_name/123', 'https://t.me/channel_name/123'],
  ['https://t.me/Jobdesk1?start=1', 'https://t.me/Jobdesk1?start=1'], ['https://t.me/abc', 'https://t.me/abc'],
  ['https://example.test/a/b', 'https://example.test/a/b'], ['site.test/careers', 'site.test/careers'],
  ['WhatsApp: https://t.me/Jobdesk1', 'WhatsApp https://t.me/Jobdesk1']])
  test('O-010 presentation-v4 contact: ' + source, () => {
    assert.equal(formatContactV4(source), expected);
    assert.equal(formatContactV4(expected), expected, 'idempotent');
  });
for (const [source, expected] of [
  ['Telegram: @user_name hr@school.test', '@user_name | hr@school.test'],
  ['@Anna_Example aexample@mail.test', '@Anna_Example | aexample@mail.test'],
  ['+7 999 123-45-67 @user_name', '+7 999 123-45-67 | @user_name'],
  ['8 999 123 45 67 hr@school.test', '8 999 123 45 67 | hr@school.test'],
  ['WhatsApp: +62 811 1234 5678 Telegram: @Example_HR', 'WhatsApp +62 811 1234 5678 | @Example_HR'],
  ['WhatsApp +7 999 123-45-67 @user_name', 'WhatsApp +7 999 123-45-67 | @user_name'],
  ['+7 999 123-45-67 Telegram @user_name', '+7 999 123-45-67 | @user_name'],
  ['WhatsApp: +62 811 1234 5678 Telegram @editor', 'WhatsApp +62 811 1234 5678 | @editor'],
  ['hr@school.test https://t.me/Jobdesk1', 'hr@school.test | @Jobdesk1'],
  ['https://example.test/a/b @user_name', 'https://example.test/a/b | @user_name'],
  ['Telegram https://t.me/+AbCdEfGh hr@school.test', 'Telegram https://t.me/+AbCdEfGh | hr@school.test'],
  ['Почта: hr@school.test; ТГ @hr_bot_name', 'hr@school.test | @hr_bot_name'],
  ['E-mail: jobs+team@example.test', 'jobs+team@example.test'],
  ['Telegram: https://t.me/Jobdesk1', '@Jobdesk1'],
  ['Telegram: https://t.me/editor?x=1&x=2', 'Telegram https://t.me/editor?x=1&x=2'],
  ['Email: https://example.test/contact', 'Email https://example.test/contact'],
  ['Phone: +7 (999) 123-45-67', 'Phone +7 (999) 123-45-67'],
  ['Telegram: @editor — писать вечером', '@editor — писать вечером'],
  ['Telegram: @editor (Phone: +1 222)', '@editor (Phone: +1 222)'],
  ['@recruiter_hr Галина', '@recruiter_hr Галина'],
  ['+62 811 1234 5678', '+62 811 1234 5678'],
  ['+7 999 1234567 +7 888 7654321', '+7 999 1234567 +7 888 7654321'],
  ['@user_name Иван hr@school.test', '@user_name Иван hr@school.test'],
  ['Telegram: @editor, обращаться к Анне, ул. Мира, 12', 'Telegram: @editor, обращаться к Анне, ул. Мира, 12'],
  ['Ms_example/hiringdesk@school.test', 'Ms_example/hiringdesk@school.test'],
  ['Signal: +62 811 1234 5678', 'Signal: +62 811 1234 5678']])
  test('O-010 presentation-v5 contact: ' + source, () => {
    const value = formatContact(source);
    assert.equal(value, expected);
    assert.equal(formatContact(value), expected, 'idempotent');
    assert.equal(value.replace(/\D/g, ''), source.replace(/\D/g, ''), 'digits unchanged');
  });
test('new snapshot preserves source inputs and reconstructs derived presentation from JSON', () => {
  const row = candidate({ final_description: 'Never used', employer_name: 'Identity', raw_input: { unchanged: true } });
  const before = structuredClone(row), result = preflightNewBatch([row]);
  assert.equal(result.ok, true); assert.deepEqual(row, before);
  const item = result.items[0], restored = JSON.parse(JSON.stringify(item));
  assert.equal(snapshotFormat(item), PRESENTATION_SNAPSHOT_VERSION);
  assert.equal(item.contact, rawContact); assert.equal(item.draft_description, row.draft_description);
  assert.equal(item.publication_contact, requestedContact);
  assert.equal(item.publication_description, '[Ксамата](https://project-site.com/) — компания.\nЗадачи:\n• Звонить.\n• Передавать лиды.');
  assert.deepEqual(frozenVacancyTransport(restored), frozenVacancyTransport(item));
  assert.equal(formatUnorderedLists(item.publication_description), item.publication_description);
  assert.equal(renderProjectBody(item.publication_description, item.project_link_text, item.project_link), item.publication_description);
});
test('post-link product limit cannot be weakened by whitespace cleanup', () => {
  const row = candidate({ draft_description: 'Ксамата\nЗадачи:\n*    Позвонить.\n-    Записать.' });
  const linked = renderProjectBody(row.draft_description, row.project_link_text, row.project_link);
  const final = formatUnorderedLists(linked), length = visibleLength(linked);
  assert.ok(final.length < linked.length);
  const result = preflightNewBatch([row], { MAX_PUBLICATION_DESCRIPTION_CHARS: length - 1 });
  assert.equal(result.ok, false); assert.equal(result.items, undefined);
  assert.equal(result.errors[0].code, 'DESCRIPTION_TOO_LONG'); assert.equal(result.errors[0].actual_chars, length);
  assert.equal(preflightNewBatch([row], { MAX_PUBLICATION_DESCRIPTION_CHARS: length }).ok, true);
});
for (const [contact, code] of [['Контакт: ', 'INVALID_CONTACT'], ['Контакт:\nКонтакт:', 'INVALID_CONTACT'],
  ['Telegram: @editor ' + 'x'.repeat(4096), 'TELEGRAM_MESSAGE_TOO_LONG:VACANCY:1'], ['bad\ud800', 'INVALID_TELEGRAM_TEXT']])
  test('formatting/transport failure returns no prepared items: ' + code, () => {
    const result = preflightNewBatch([candidate({ contact })]);
    assert.equal(result.ok, false); assert.equal(result.items, undefined);
    assert.ok(result.errors.some(e => e.code === code && e.application_id === 'formatting' && e.row_number === 2));
  });

const directory = mkdtempSync(join(tmpdir(), 'workflow-b-formatting-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const artifact = join(directory, 'portable.json');
execFileSync(process.execPath, [fileURLToPath(new URL('./build-workflow-b.mjs', import.meta.url)), artifact, '--credential-free'], { env: {} });
const workflow = JSON.parse(readFileSync(artifact, 'utf8'));
const env = { GOOGLE_SHEETS_DOCUMENT_ID: 'synthetic-formatting', WORKFLOW_B_TELEGRAM_CHAT_ID: '-1001234567890', WORKFLOW_B_TELEGRAM_EXPECTED_BOT_ID: '222' };
const c = sheetsConfig(env);
const state = f => persistenceState(c, f.metadata(), f.get(readPlan(c, f.metadata()).url));
const rows = () => [{ ...example('first', 10), draft_description: candidate().draft_description,
  project_link_text: 'Ксамата', 'Project Website Link': candidate().project_link, 'Contact Info': rawContact }, example('second', 20)];
const ready = () => {
  const f = new SheetFixture(rows()); f.commit(setupPlan(c, f.metadata(), f.sheet(c.applications).values).requests);
  for (const row of [2, 3]) { f.edit(c.applications, row, 'human_decision', 'PUBLISH'); f.edit(c.applications, row, 'publication_order', row * 10); }
  f.control(c, true); f.calls = []; return f;
};
// Model a valid frozen CREATED batch retained after publication preflight fails.
const freeze = async f => {
  await assert.rejects(runGraph(workflow, f, env, undefined, async () => [{ ok: false }]), /DESTINATION_MISMATCH/);
  assert.equal(state(f).active.batch_status, 'CREATED');
};
test('portable current artifact embeds exact current domain and executes list/contact full retry', async () => {
  assert.equal(workflow.active, false); assert.equal(workflow.nodes.some(n => n.credentials), false);
  const domain = bundledDomain();
  for (const node of workflow.nodes.filter(n => n.type.endsWith('.code'))) assert.ok(node.parameters.jsCode.startsWith(domain));
  const result = await verifyHyperlinkWorkflow(workflow);
  assert.equal(result.list_contact_presentation_frozen, true); assert.equal(result.full_retry_identical, true);
});
for (const change of [{ 'Contact Info': 'Контакт: ' }, { 'Contact Info': 'x'.repeat(4096) },
  { draft_description: 'Approved\nЗадачи:\n* [сломано' }, { draft_description: 'Approved ' + 'я'.repeat(900) }])
  test('generated whole-batch formatting failure precedes claim/persistence/sends: ' + Object.keys(change), async () => {
    const f = ready();
    for (const [key, value] of Object.entries(change)) f.edit(c.applications, 3, key, value);
    const before = structuredClone(f.sheets);
    const result = await runGraph(workflow, f, env, undefined, () => { throw Error('no Telegram'); });
    assert.equal(result.result.kind, 'PREFLIGHT_FAILED'); assert.ok(result.result.errors.some(e => e.application_id === 'second'));
    assert.deepEqual(f.sheets, before); assert.equal(f.calls.filter(x => x.method === 'POST').length, 0);
    assert.equal(f.sheet(c.claim), undefined);
  });
for (const change of [{ publication_contact: '' }, { publication_contact: 'changed' }, { contact: 'Phone: +1 222' },
  { publication_description: 'changed' }, { snapshot_version: 'unknown' }, { snapshot_version: '' },
  { snapshot_version: PROJECT_LINK_SNAPSHOT_VERSION }])
  test('new frozen presentation rejects inconsistent metadata: ' + JSON.stringify(change), async () => {
    const f = ready(); await freeze(f);
    for (const [key, value] of Object.entries(change)) f.edit(c.items, 2, key, value);
    const before = structuredClone(f.sheets), count = f.calls.filter(x => x.method === 'POST').length;
    await assert.rejects(runGraph(workflow, f, { ...env, WORKFLOW_B_MODE: 'run' }, undefined, () => { throw Error('no Telegram'); }),
      /INCOMPLETE_SNAPSHOT_CONTENT|UNSUPPORTED_SNAPSHOT_FORMAT/);
    assert.deepEqual(f.sheets, before); assert.equal(f.calls.filter(x => x.method === 'POST').length, count);
  });

function historical(item, format) {
  const old = { ...item, publication_contact: '' };
  if (['presentation-v1', 'presentation-v2'].includes(format)) {
    old.snapshot_version = format;
    old.contact = format === 'presentation-v1' ? 'WhatsApp: +62 811 1234 5678 Telegram: @Example_HR'
      : 'WhatsApp:\u00a0+62 811 1234 5678  Telegram:\u00a0@Example_HR';
    old.publication_contact = old.contact;
  } else if (format === 'presentation-v4') {
    // presentation-v5 would split and drop the label; a frozen v4 item keeps it.
    old.snapshot_version = format;
    old.contact = 'Telegram: @Example_HR hr@example.test';
    old.publication_contact = 'Telegram: @Example_HR hr@example.test';
  } else if (format === 'presentation-v3') {
    // presentation-v4 would show @Example_HR; a frozen v3 item keeps its URL.
    old.snapshot_version = format;
    old.contact = 'Telegram: https://t.me/Example_HR';
    old.publication_contact = 'Telegram https://t.me/Example_HR';
  } else if (format === 'legacy') for (const key of PRESENTATION_FIELDS) old[key] = '';
  else {
    old.snapshot_version = PROJECT_LINK_SNAPSHOT_VERSION;
    old.publication_description = renderProjectBody(old.draft_description, old.project_link_text, old.project_link);
  }
  old.rendered_text = renderVacancy(old); return old;
}
for (const format of ['legacy', PROJECT_LINK_SNAPSHOT_VERSION, 'presentation-v1', 'presentation-v2', 'presentation-v3', 'presentation-v4']) test('historical ' + format + ' keeps literal lists/contacts through full retry without new headers', async () => {
  const f = ready(); await freeze(f);
  const oldFields = [...LEGACY_ITEM_FIELDS, ...(format === 'legacy' ? [] : format.startsWith('presentation-') ? PRESENTATION_FIELDS : PROJECT_LINK_FIELDS)];
  const old = state(f).active.items.map(i => historical(i, format));
  f.sheet(c.items).values = [oldFields, ...old.map(i => oldFields.map(k => i[k]))];
  assert.equal(state(f).active.items[0].rendered_text, old[0].rendered_text);
  for (const key of ['draft_description', 'project_link_text', 'Project Website Link', 'Contact Info'])
    f.edit(c.applications, 2, key, 'LATER EDIT');
  const sends = []; let failing = true, id = 100;
  const telegram = async (_, p) => {
    if (p.operation === 'get') return [{ ok: true, result: { id: Number(env.WORKFLOW_B_TELEGRAM_CHAT_ID), type: 'channel' } }];
    if (p.operation === 'administrators') return [{ status: 'administrator', can_post_messages: true, user: { id: 222, is_bot: true } }];
    sends.push(p.text);
    if (failing && sends.length === 3) throw Error('synthetic failure');
    return [{ ok: true, result: { message_id: id++, date: 1789862400, chat: { id: Number(env.WORKFLOW_B_TELEGRAM_CHAT_ID), type: 'channel' } } }];
  };
  const run = () => runGraph(workflow, f, { ...env, WORKFLOW_B_MODE: 'run' }, undefined, telegram);
  await assert.rejects(run(), /FAILED/);
  assert.ok(sends[1].includes(format.startsWith('presentation-')
    ? '\nЗадачи:\n• Звонить.\n• Передавать лиды.' : '\nЗадачи:\n* Звонить.\n- Передавать лиды.'));
  assert.ok(sends[1].endsWith('\n\nКонтакт: ' + (format.startsWith('presentation-') ? old[0].publication_contact : rawContact)));
  assert.ok(sends[1].includes(format === 'legacy' ? '[Ксамата](https://project-site.com/)' : '<a href="https://project-site.com/">Ксамата</a>'));
  // External manual cleanup is modeled; B never deletes messages.
  failing = false; const result = await run();
  assert.equal(result.result.kind, 'COMPLETED'); assert.deepEqual(sends.slice(0, 3), sends.slice(3, 6));
  assert.deepEqual(f.sheet(c.items).values[0], oldFields);
  assert.equal(state(f).items[0].rendered_text, old[0].rendered_text);
});
test('mixed old/new versions fail even when each item is individually consistent', async () => {
  const f = ready(); await freeze(f);
  const batch = state(f).active, items = [batch.items[0], historical(batch.items[1], PROJECT_LINK_SNAPSHOT_VERSION)];
  assert.throws(() => reconstructBatch(batch, items), /INCONSISTENT_SNAPSHOT_FORMAT/);
});
test('old discriminators reject leaked new presentation metadata', () => {
  const item = prepared();
  for (const format of ['legacy', PROJECT_LINK_SNAPSHOT_VERSION]) {
    const old = historical(item, format);
    assert.throws(() => snapshotFormat({ ...old, publication_contact: 'unexpected' }), /UNSUPPORTED_SNAPSHOT_FORMAT/);
  }
});
test('existing project-links item headers gain only derived contact in the atomic new-batch commit', async () => {
  const f = ready(), oldFields = [...LEGACY_ITEM_FIELDS, ...PROJECT_LINK_FIELDS, 'operator_note'];
  f.sheet(c.items).values = [oldFields]; f.sheet(c.items).properties.gridProperties.columnCount = oldFields.length;
  await freeze(f);
  assert.deepEqual(f.sheet(c.items).values[0], [...oldFields, 'publication_contact']);
  const commits = f.calls.filter(x => x.method === 'POST');
  assert.equal(commits.length, 1);
  assert.ok(commits[0].requests.some(r => r.addSheet?.properties.title === c.claim));
  assert.equal(table(f.sheet(c.items).values).rows[0].publication_contact, requestedContact);
});


for (const space of ['\u00a0', '\u202f', '\u2009', ' ', '\t']) {
  test('service punctuation accepts horizontal Unicode space ' + JSON.stringify(space), () => {
    const source = `WhatsApp:${space}+62 811 1234 5678${space}${space}Telegram:${space}@Example_HR`;
    const item = prepared({ contact: source });
    assert.equal(item.contact, source);
    assert.equal(item.publication_contact, requestedContact);
    assert.ok(frozenVacancyTransport(item).text.endsWith('\n\nКонтакт: ' + requestedContact));
    assert.equal(formatContact(item.publication_contact), requestedContact);
  });
}
for (const source of [
  'm.recruiter@example.org\u00a0 / ТГ @recruiter_hr Галина ',
  String.raw`m.recruiter\@example.org / ТГ @recruiter\_hr Галина`,
]) test('execution 116 contact with email slash TG and trailing note: ' + source, () => {
  const item = prepared({ contact: source });
  const expected = 'm.recruiter@example.org | @recruiter_hr Галина';
  assert.equal(item.contact, source); assert.equal(item.publication_contact, expected);
  assert.equal(formatContactV4(source), 'm.recruiter@example.org | ТГ @recruiter_hr Галина');
  const text = frozenVacancyTransport(item).text;
  assert.ok(text.endsWith('\n\nКонтакт: ' + expected));
  assert.equal((text.match(/Контакт:/g) ?? []).length, 1);
  assert.equal(/\\[@_]/.test(text), false);
  assert.equal(formatContact(expected), expected);
});
for (const source of [
  'https://example.test/a/b?x=a/b',
  'https://example.test/a/b?x=a/b / неизвестный способ связи',
  'Telegram: @editor / адрес неизвестен',
  String.raw`ТГ @recruiter\\_hr Галина`,
  String.raw`m.recruiter\\@example.org / ТГ @recruiter_hr Галина`,
  String.raw`C:\notes\@file / ТГ @recruiter_hr Галина`,
]) test('contact boundaries and unrecognized escapes stay intact: ' + source, () => {
  assert.equal(formatContact(source), source);
  assert.equal(formatContactV4(source), source);
});
test('nonbreaking phone spacing and notes survive recognition', () => {
  const source = 'WhatsApp:\u00a0+62\u00a0811\u202f1234 5678 / ТГ @editor Галина';
  assert.equal(formatContact(source), 'WhatsApp +62\u00a0811\u202f1234 5678 | @editor Галина');
  assert.equal(formatContactV4(source), 'WhatsApp +62\u00a0811\u202f1234 5678 | ТГ @editor Галина');
});

test('Unicode note boundaries preserve accompanying note content', () => {
  for (const note of ['\u00a0(Галина)', '\u202f—\u00a0писать вечером']) {
    assert.equal(formatContact('ТГ:\u00a0@editor' + note), '@editor' + note);
    assert.equal(formatContactV4('ТГ:\u00a0@editor' + note), 'ТГ @editor' + note);
  }
});
