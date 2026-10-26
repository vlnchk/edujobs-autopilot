import { START_MARKER, END_MARKER, escapeHtml, frozenVacancyTransport, validateTelegramSize } from './workflow-b-domain.mjs';
import { BATCH_FIELDS, LEGACY_ITEM_FIELDS, APPLICATION_FIELDS, persistenceState, reconstructBatch,
  properties, table, writeCells } from './workflow-b-sheets.mjs';

// Pure publication plans. Only the generated graph performs I/O.
const publicationFail = code => { throw new Error(code); };
const present = value => value !== '' && value !== null && value !== undefined;
const positiveId = value => Number.isSafeInteger(value) && value > 0;
export function telegramConfig(env) {
  const chat_id = env.WORKFLOW_B_TELEGRAM_CHAT_ID;
  const expected_bot_id = env.WORKFLOW_B_TELEGRAM_EXPECTED_BOT_ID;
  if (typeof chat_id !== 'string' || !/^-100[1-9]\d*$/.test(chat_id)
    || !Number.isSafeInteger(Number(chat_id))) publicationFail('INVALID_TELEGRAM_CHANNEL_ID');
  if (typeof expected_bot_id !== 'string' || !/^[1-9]\d*$/.test(expected_bot_id)
    || !positiveId(Number(expected_bot_id))) publicationFail('INVALID_EXPECTED_BOT_ID');
  return { chat_id, expected_bot_id: Number(expected_bot_id), parse_mode: 'HTML',
    disable_web_page_preview: true, disable_notification: false, appendAttribution: false };
}
export function escapeTelegramText(value) {
  return escapeHtml(value);
}
function telegramPayload(kind, text, visible, config, position = null) {
  // UTF-16 units are a conservative bound, also covering Telegram entity offsets.
  validateTelegramSize(visible, kind, position);
  return { kind, batch_position: position, text, chat_id: config.chat_id,
    parse_mode: config.parse_mode, disable_web_page_preview: config.disable_web_page_preview,
    disable_notification: config.disable_notification, appendAttribution: config.appendAttribution };
}
export function encodeFrozenVacancy(item, config) {
  const { text, visible } = frozenVacancyTransport(item);
  return telegramPayload('VACANCY', text, visible, config, item.batch_position);
}

export const publicationStep = context => context.sequence[context.cursor]?.kind === 'VACANCY'
  ? 'VACANCY:' + context.sequence[context.cursor].batch_position
  : context.sequence[context.cursor]?.kind ?? 'COMPLETE';

export function preparePublication(c, metadata, response, config) {
  // Validate transport flags even when the caller supplies an object directly.
  const expected = telegramConfig({ WORKFLOW_B_TELEGRAM_CHAT_ID: config?.chat_id,
    WORKFLOW_B_TELEGRAM_EXPECTED_BOT_ID: String(config?.expected_bot_id ?? '') });
  if (Object.keys(expected).some(k => expected[k] !== config[k])) publicationFail('INVALID_TELEGRAM_TRANSPORT_CONFIG');
  const state = persistenceState(c, metadata, response);
  const batch = state.active;
  if (!batch) return { kind: 'NO_UNFINISHED_BATCH' };
  if (batch.batch_status === 'PUBLISHING') return { kind: 'BATCH_ALREADY_PUBLISHING', batch_id: batch.batch_id };
  if (batch.batch_status === 'CREATED' && (
    ['started_at', 'completed_at', 'start_telegram_message_id', 'end_telegram_message_id',
      'last_publication_error', 'diagnostic_or_unknown_state_note'].some(k => present(batch[k]))
    || batch.items.some(item => item.item_state !== 'NOT_SENT'
      || ['telegram_message_id', 'telegram_message_url', 'published_at'].some(k => present(item[k])))))
    publicationFail('INCONSISTENT_CREATED_ACKNOWLEDGEMENTS');
  const sequence = [telegramPayload('START', escapeTelegramText(START_MARKER), START_MARKER, config),
    ...batch.items.map(i => encodeFrozenVacancy(i, config)),
    telegramPayload('END', escapeTelegramText(END_MARKER), END_MARKER, config)];
  const batches = table(response.valueRanges[1].values, BATCH_FIELDS);
  const items = table(response.valueRanges[2].values, LEGACY_ITEM_FIELDS);
  const context = { config, batch, sequence, cursor: 0, c,
    batch_target: { sheet_id: properties(metadata, c.batches).sheetId, headers: batches.headers,
      row: batches.rows.find(b => b.batch_id === batch.batch_id).row_number },
    item_targets: batch.items.map(item => ({ sheet_id: properties(metadata, c.items).sheetId, headers: items.headers,
      row: items.rows.find(i => i.batch_id === batch.batch_id && i.batch_position === item.batch_position).row_number })),
  };
  return context;
}
export function validateTelegramChat(config, response) {
  const chat = response?.result;
  if (response?.ok !== true || !chat || !Number.isSafeInteger(chat.id)
    || String(chat.id) !== config.chat_id || chat.type !== 'channel') publicationFail('TELEGRAM_DESTINATION_MISMATCH');
  return true;
}
export function validateTelegramAdministrators(config, administrators) {
  if (!Array.isArray(administrators) || !administrators.length) publicationFail('INVALID_TELEGRAM_ADMINISTRATORS');
  const ids = new Set();
  for (const member of administrators) {
    if (!member || member.error || !positiveId(member.user?.id) || typeof member.user.is_bot !== 'boolean'
      || !['administrator', 'creator'].includes(member.status) || ids.has(member.user.id)) publicationFail('INVALID_TELEGRAM_ADMINISTRATORS');
    ids.add(member.user.id);
  }
  // Native getChatAdministrators does not set return_bots: only the current
  // credential's bot may appear. Zero/multiple bot records fail closed.
  const bots = administrators.filter(member => member.user.is_bot === true);
  if (bots.length !== 1) publicationFail('AMBIGUOUS_TELEGRAM_BOT_IDENTITY');
  const bot = bots[0];
  if (bot.user.id !== config.expected_bot_id) publicationFail('TELEGRAM_BOT_IDENTITY_MISMATCH');
  if (bot.status !== 'creator' && bot.can_post_messages !== true) publicationFail('TELEGRAM_PUBLISH_PERMISSION_MISSING');
  if (bot.status === 'creator' && present(bot.can_post_messages) && bot.can_post_messages !== true) publicationFail('INVALID_TELEGRAM_ADMINISTRATORS');
  return true;
}
export function publicationTargets(context, metadata, applicationValues) {
  const { headers, rows } = table(applicationValues, ['application_id', ...APPLICATION_FIELDS]);
  const sheetId = properties(metadata, context.c.applications).sheetId;
  const targets = context.batch.items.map(item => {
    const matches = rows.filter(r => r.application_id === item.application_id);
    const row = matches[0];
    if (matches.length !== 1 || sheetId !== item.application_sheet_id || row.row_number !== item.application_row_number
      || row.batch_id !== item.batch_id || row.batch_position !== item.batch_position
      || context.batch.batch_status === 'CREATED'
        && ['telegram_message_id', 'telegram_message_url', 'published_at'].some(k => present(row[k]))) publicationFail('APPLICATION_ACK_TARGET_MISMATCH');
    // FAILED delivery evidence may differ after an uncertain write; reset it all.
    // Read only identity/association/ack metadata. Body, links, decisions and
    // order from mutable Applications are deliberately never consulted.
    return { sheet_id: sheetId, row: row.row_number, headers };
  });
  return { ...context, application_targets: targets };
}
function fieldRequests(target, values) {
  return Object.entries(values).map(([field, value]) => {
    const column = target.headers.indexOf(field);
    if (column < 0) publicationFail(`MISSING_ACK_COLUMN:${field}`);
    return writeCells(target.sheet_id, target.row - 1, column, [[value]]);
  });
}
export function beginPublication(context) {
  if (!context.application_targets || context.application_targets.length !== context.batch.items.length
    || !['CREATED', 'FAILED'].includes(context.batch.batch_status) || context.cursor !== 0
    || context.sequence[0]?.kind !== 'START') publicationFail('INVALID_PUBLICATION_BEGIN');
  const fields = { batch_status: 'PUBLISHING', last_publication_error: '', diagnostic_or_unknown_state_note: '' };
  const delivery = { telegram_message_id: '', telegram_message_url: '', published_at: '' };
  const retry = context.batch.batch_status === 'FAILED';
  if (retry) Object.assign(fields, { started_at: '', completed_at: '',
    start_telegram_message_id: '', end_telegram_message_id: '' });
  const batch = { ...context.batch, ...fields, items: context.batch.items.map(item =>
    retry ? { ...item, item_state: 'NOT_SENT', ...delivery } : { ...item }) };
  const requests = fieldRequests(context.batch_target, fields);
  if (retry) for (let i = 0; i < batch.items.length; i++) {
    requests.push(...fieldRequests(context.item_targets[i], { item_state: 'NOT_SENT', ...delivery }),
      ...fieldRequests(context.application_targets[i], delivery));
  }
  // One atomic request clears delivery state and starts the attempt. Frozen
  // content, identity, positions, source references and creation fields stay put.
  if (JSON.stringify({ requests }).length > 1500000) publicationFail('ATOMIC_REQUEST_TOO_LARGE');
  return { ...context, batch, cursor: 0, requests };
}

export function confirmSheetsCommit(response, plan) {
  if (response?.error || !Array.isArray(response?.replies) || response.replies.length !== plan.requests.length) publicationFail('UNCONFIRMED_PUBLICATION_WRITE');
  return plan;
}
export function currentPublication(context) {
  if (context.batch.batch_status !== 'PUBLISHING' || !context.sequence[context.cursor]) publicationFail('INVALID_PUBLICATION_CURSOR');
  return context;
}
export function acknowledgementPlan(context, response) {
  currentPublication(context);
  const message = response?.result;
  const payload = context.sequence[context.cursor];
  if (response?.ok !== true || !positiveId(message?.message_id) || !positiveId(message?.date)
    || !Number.isSafeInteger(message?.chat?.id) || String(message.chat.id) !== context.config.chat_id
    || message.chat.type !== 'channel') publicationFail('MISSING_OR_INVALID_TELEGRAM_ACKNOWLEDGEMENT');
  const time = new Date(message.date * 1000);
  if (!Number.isFinite(time.getTime())) publicationFail('INVALID_TELEGRAM_ACK_TIME');
  const stamp = time.toISOString();
  const batch = { ...context.batch, items: context.batch.items.map(i => ({ ...i })) };
  if ([batch.start_telegram_message_id, batch.end_telegram_message_id, ...batch.items.map(i => i.telegram_message_id)]
    .some(id => present(id) && String(id) === String(message.message_id))) publicationFail('DUPLICATE_TELEGRAM_ACKNOWLEDGEMENT');
  let requests;
  if (payload.kind === 'START') {
    if (context.cursor !== 0 || present(batch.start_telegram_message_id)) publicationFail('INVALID_START_SEQUENCE');
    const fields = { start_telegram_message_id: message.message_id, started_at: stamp };
    Object.assign(batch, fields); requests = fieldRequests(context.batch_target, fields);
  } else if (payload.kind === 'VACANCY') {
    const index = payload.batch_position - 1;
    if (!present(batch.start_telegram_message_id) || batch.items[index].item_state !== 'NOT_SENT'
      || batch.items.slice(0, index).some(i => i.item_state !== 'SENT')) publicationFail('INVALID_VACANCY_SEQUENCE');
    const fields = { telegram_message_id: message.message_id,
      telegram_message_url: `https://t.me/c/${context.config.chat_id.slice(4)}/${message.message_id}`, published_at: stamp };
    Object.assign(batch.items[index], fields, { item_state: 'SENT' });
    // All item and Applications metadata is committed in this ONE API request.
    requests = [...fieldRequests(context.item_targets[index], { item_state: 'SENT', ...fields }),
      ...fieldRequests(context.application_targets[index], fields)];
  } else {
    if (payload.kind !== 'END' || !present(batch.start_telegram_message_id) || batch.items.some(i => i.item_state !== 'SENT')) publicationFail('INVALID_END_SEQUENCE');
    const fields = { end_telegram_message_id: message.message_id, completed_at: stamp, batch_status: 'COMPLETED' };
    Object.assign(batch, fields); reconstructBatch(batch, batch.items);
    requests = fieldRequests(context.batch_target, fields);
  }
  return { ...context, batch, requests, cursor: context.cursor + 1 };
}
export function classifyTelegramFailure(response) {
  // Never retry Telegram automatically, including structured or native 429s.
  const structured = !present(response?.error) && !present(response?.result) && response?.ok === false
    && Number.isInteger(response.error_code) && typeof response.description === 'string' && response.description.length;
  return { failure_code: structured ? 'TELEGRAM_REJECTED_' + response.error_code : 'TELEGRAM_ACK_UNCERTAIN' };
}
export function publicationStopPlan(context, code) {
  if (context.batch.batch_status !== 'PUBLISHING') publicationFail('INVALID_PUBLICATION_STOP');
  const fields = { batch_status: 'FAILED', last_publication_error: code,
    diagnostic_or_unknown_state_note: 'Stopped at ' + publicationStep(context)
      + '; manual Telegram cleanup of ALL messages from this attempt is required, then full-batch restart from START.' };
  return { ...context, batch: { ...context.batch, ...fields }, failure_code: code, failure_status: 'FAILED',
    requests: fieldRequests(context.batch_target, fields) };
}
export function stopAfterUnconfirmedWrite(context, response) {
  // One Sheets read protects an END commit whose response was lost. This never
  // advances or restarts a send, and does not reconcile Telegram delivery.
  const { headers, rows } = table(response.valueRanges?.[0]?.values, BATCH_FIELDS);
  const saved = rows.filter(row => row.batch_id === context.batch.batch_id);
  if (saved.length !== 1 || saved[0].row_number !== context.batch_target.row
    || JSON.stringify(headers) !== JSON.stringify(context.batch_target.headers))
    publicationFail('UNCONFIRMED_PUBLICATION_WRITE: inspect batch in Sheets and n8n UI');
  if (saved[0].batch_status === 'COMPLETED')
    publicationFail('PUBLICATION_ALREADY_COMPLETED: acknowledgement response lost; completed history preserved');
  if (saved[0].batch_status !== 'PUBLISHING') publicationFail('UNEXPECTED_BATCH_STATUS_AFTER_WRITE');
  return { ...context, failure_code: 'UNCONFIRMED_PUBLICATION_WRITE' };
}
