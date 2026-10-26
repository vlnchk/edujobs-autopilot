import {
  BATCH_STATE, ITEM_STATE, DEFAULT_CONFIG, parseHumanDecision, parsePublicationOrder, selectNewBatch,
  createBatchSnapshot, matchesFrozenVacancy, validateBatchState, validateItemState, PRESENTATION_FIELDS, snapshotFormat,
} from './workflow-b-domain.mjs';

// Pure Sheets request planning. The generated HTTP nodes own all network I/O.
export const APPLICATION_FIELDS = Object.freeze([
  'human_decision', 'publication_order', 'batch_id', 'batch_position',
  'telegram_message_id', 'telegram_message_url', 'published_at',
]);
export const BATCH_FIELDS = Object.freeze([
  'batch_id', 'batch_status', 'created_at', 'started_at', 'completed_at', 'vacancy_count',
  'start_telegram_message_id', 'end_telegram_message_id', 'last_publication_error',
  'diagnostic_or_unknown_state_note', 'workflow_version', 'config_version',
]);
export const LEGACY_ITEM_FIELDS = Object.freeze([
  'batch_id', 'application_id', 'application_sheet_id', 'application_row_number',
  'batch_position', 'publication_order', 'draft_description', 'details_link', 'contact',
  'rendered_text', 'item_state', 'telegram_message_id', 'telegram_message_url', 'published_at',
]);
export const ITEM_FIELDS = Object.freeze([...LEGACY_ITEM_FIELDS, ...PRESENTATION_FIELDS]);
const requiredUpstream = ['application_id', 'processing_status', 'primary_reason', 'review_reason',
  'draft_description', 'final_description', 'project_link_text', 'Project Website Link', 'Original Link', 'Contact Info'];
const nonempty = value => value !== '' && value !== null && value !== undefined;
const fail = code => { throw new Error(code); };

export function sheetsConfig(env = {}) {
  const c = {
    spreadsheet_id: env.GOOGLE_SHEETS_DOCUMENT_ID || '',
    applications: env.GOOGLE_SHEETS_SHEET_NAME || 'Applications',
    review: env.WORKFLOW_B_REVIEW_QUEUE_TAB || 'Review Queue',
    archive: env.WORKFLOW_B_ARCHIVE_TAB || 'Archive',
    control: env.WORKFLOW_B_CONTROL_TAB || 'Control',
    batches: env.WORKFLOW_B_BATCHES_TAB || 'Publication Batches',
    items: env.WORKFLOW_B_ITEMS_TAB || 'Publication Batch Items',
    claim: env.WORKFLOW_B_CLAIM_TAB || '_Workflow B Claim',
    control_cell: env.WORKFLOW_B_CONTROL_CELL || 'B2',
    details_column: 'Original Link',
    MAX_PUBLICATION_DESCRIPTION_CHARS: Number(env.MAX_PUBLICATION_DESCRIPTION_CHARS || DEFAULT_CONFIG.MAX_PUBLICATION_DESCRIPTION_CHARS),
    workflow_version: env.WORKFLOW_B_VERSION || 'workflow-b-presentation-v5',
    config_version: env.WORKFLOW_B_CONFIG_VERSION || 'presentation-v5',
    mode: env.WORKFLOW_B_MODE || 'run',
  };
  if (!/^[a-zA-Z0-9_-]+$/.test(c.spreadsheet_id)) fail('MISSING_OR_INVALID_SPREADSHEET_ID');
  if (['prepare', 'publish'].includes(c.mode)) fail('WORKFLOW_B_MODE_MIGRATION_REQUIRED: Set WORKFLOW_B_MODE=run once and reload the n8n runtime environment. Run can create and send a batch in one execution; review the checkbox and unfinished batch before executing. Keep setup only for a fresh workbook.');
  if (!['setup', 'run'].includes(c.mode)) fail('INVALID_MODE');
  const tabs = ['applications', 'review', 'archive', 'control', 'batches', 'items', 'claim'].map(k => c[k]);
  if (new Set(tabs).size !== tabs.length || tabs.some(t => !t.trim() || /[\[\]:*?/\\]/.test(t) || t.length > 100)) fail('INVALID_TAB_NAMES');
  if (!Number.isSafeInteger(c.MAX_PUBLICATION_DESCRIPTION_CHARS) || c.MAX_PUBLICATION_DESCRIPTION_CHARS <= 0) fail('INVALID_DESCRIPTION_LIMIT');
  if (env.WORKFLOW_B_DETAILS_LINK_COLUMN && env.WORKFLOW_B_DETAILS_LINK_COLUMN !== 'Original Link') fail('O005_ORIGINAL_LINK_ONLY');
  cellPosition(c.control_cell);
  return c;
}
export function cellPosition(a1) {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(a1);
  if (!match) fail('INVALID_CONTROL_CELL');
  const column = [...match[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const row = Number(match[2]) - 1;
  if (column < 1 || column >= 18278 || !Number.isSafeInteger(row) || row > 999999) fail('INVALID_CONTROL_CELL');
  return { row, column };
}
export function columnName(index) {
  let value = index + 1, result = '';
  while (value > 0) { result = String.fromCharCode(65 + (value - 1) % 26) + result; value = Math.floor((value - 1) / 26); }
  return result;
}
export const quotedTab = title => `'${title.replace(/'/g, "''")}'`;
export const apiBase = c => `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(c.spreadsheet_id)}`;
export function properties(metadata, title, optional = false) {
  const p = metadata.sheets?.find(s => s.properties.title === title)?.properties;
  if (!p && !optional) fail(`MISSING_TAB:${title}:RUN_SETUP`);
  return p ?? null;
}
export function table(values = [], required = []) {
  const headers = values[0] ?? [];
  if (headers.some(h => typeof h !== 'string' || !h) || new Set(headers).size !== headers.length) fail('INVALID_OR_DUPLICATE_HEADERS');
  for (const h of required) if (!headers.includes(h)) fail(`MISSING_COLUMN:${h}: Restore the required column in the source table; Workflow B does not create upstream fields.`);
  const rows = values.slice(1).map((cells, i) => ({
    ...Object.fromEntries(headers.map((h, j) => [h, cells[j] ?? ''])), row_number: i + 2,
  })).filter((r, i) => (values[i + 1] ?? []).some(nonempty));
  return { headers, rows };
}
export function readPlan(c, metadata, latest = false) {
  const titles = latest || c.mode === 'setup' ? [c.applications] : [c.control, c.batches, c.items];
  const ranges = titles.map(title => {
    properties(metadata, title);
    return title === c.control ? `${quotedTab(title)}!${c.control_cell}` : quotedTab(title);
  });
  if (!latest && c.mode !== 'setup' && properties(metadata, c.claim, true)) ranges.push(`${quotedTab(c.claim)}!A1`);
  return { url: `${apiBase(c)}/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING&${ranges.map(r => `ranges=${encodeURIComponent(r)}`).join('&')}` };
}
export function published(row) {
  return nonempty(row.published_at) && nonempty(row.telegram_message_id);
}
export function projectionRows(rows) {
  const archive = [], review = [];
  for (const row of rows) (parseHumanDecision(row.human_decision) === 'REJECT' || published(row) ? archive : review).push({ ...row });
  return { review, archive };
}
export function projectionFormula(c, headers, archive = false) {
  const t = quotedTab(c.applications), last = columnName(headers.length - 1);
  const col = name => `${t}!${columnName(headers.indexOf(name))}2:${columnName(headers.indexOf(name))}`;
  const resolved = `((${col('human_decision')}="REJECT")+((${col('published_at')}<>"")*(${col('telegram_message_id')}<>"")))`;
  const data = `${t}!A2:${last}`;
  return `={${t}!A1:${last}1;IFNA(FILTER(${data},BYROW(${data},LAMBDA(r,COUNTA(r)>0)),${resolved}${archive ? '>0' : '=0'}),MAKEARRAY(1,${headers.length},LAMBDA(r,c,"")))}`;
}
function cellData(value) {
  if (typeof value === 'string' && value.length > 50000) fail('SHEET_CELL_TOO_LARGE');
  return { userEnteredValue: typeof value === 'boolean' ? { boolValue: value }
    : typeof value === 'number' ? { numberValue: value } : { stringValue: String(value ?? '') } };
}
export function writeCells(sheetId, row, column, values) {
  return { updateCells: { start: { sheetId, rowIndex: row, columnIndex: column },
    rows: values.map(cells => ({ values: cells.map(cellData) })), fields: 'userEnteredValue' } };
}
const appendRows = (sheetId, rows) => ({ appendCells: { sheetId,
  rows: rows.map(cells => ({ values: cells.map(cellData) })), fields: 'userEnteredValue' } });
function ensureSize(p, rows, columns) {
  const requests = [];
  for (const [dimension, count, wanted] of [['ROWS', p.gridProperties.rowCount, rows], ['COLUMNS', p.gridProperties.columnCount, columns]]) {
    if (count < wanted) requests.push({ appendDimension: { sheetId: p.sheetId, dimension, length: wanted - count } });
  }
  return requests;
}
export function setupPlan(c, metadata, applicationValues) {
  const app = properties(metadata, c.applications);
  const { headers } = table(applicationValues, requiredUpstream);
  // Bootstrap only; never overwrite existing operator controls or B persistence.
  for (const name of [c.review, c.archive, c.control, c.batches, c.items, c.claim]) {
    if (properties(metadata, name, true)) fail(`SETUP_TAB_ALREADY_EXISTS:${name}`);
  }
  const missing = APPLICATION_FIELDS.filter(f => !headers.includes(f));
  const all = [...headers, ...missing];
  const requests = ensureSize(app, 2, all.length);
  if (missing.length) requests.push(writeCells(app.sheetId, 0, headers.length, [missing]));
  const pos = cellPosition(c.control_cell);
  let id = Math.max(...metadata.sheets.map(s => s.properties.sheetId)) + 1;
  const ids = {};
  for (const title of [c.review, c.archive, c.control, c.batches, c.items]) {
    ids[title] = id++;
    requests.push({ addSheet: { properties: { sheetId: ids[title], title, gridProperties: {
      rowCount: Math.max(app.gridProperties.rowCount + 1, pos.row + 1, 100),
      columnCount: Math.max(all.length, ITEM_FIELDS.length, pos.column + 1), frozenRowCount: 1,
    } } } });
  }
  requests.push(writeCells(ids[c.batches], 0, 0, [BATCH_FIELDS]), writeCells(ids[c.items], 0, 0, [ITEM_FIELDS]));
  for (const [title, archive] of [[c.review, false], [c.archive, true]]) {
    requests.push({ updateCells: { start: { sheetId: ids[title], rowIndex: 0, columnIndex: 0 },
      rows: [{ values: [{ userEnteredValue: { formulaValue: projectionFormula(c, all, archive) },
        note: 'Projection only. Edit canonical Applications rows; do not type into this formula result.' }] }], fields: 'userEnteredValue,note' } });
  }
  requests.push(writeCells(ids[c.control], pos.row, pos.column - 1, [['Publish approved vacancies', false]]));
  requests.push({ setDataValidation: { range: { sheetId: ids[c.control], startRowIndex: pos.row, endRowIndex: pos.row + 1,
    startColumnIndex: pos.column, endColumnIndex: pos.column + 1 }, rule: { condition: { type: 'BOOLEAN' }, strict: true, showCustomUi: true } } });
  const decisionColumn = all.indexOf('human_decision');
  requests.push({ setDataValidation: { range: { sheetId: app.sheetId, startRowIndex: 1,
    startColumnIndex: decisionColumn, endColumnIndex: decisionColumn + 1 },
  rule: { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'PUBLISH' }, { userEnteredValue: 'REJECT' }] }, strict: true, showCustomUi: true } } });
  return { kind: 'SETUP', requests };
}
export function reconstructBatch(batch, items) {
  validateBatchState(batch.batch_status);
  if (!Number.isSafeInteger(batch.vacancy_count) || batch.vacancy_count < 1 || !nonempty(batch.created_at)) fail('INCOMPLETE_BATCH_HEADER');
  const ordered = items.filter(i => i.batch_id === batch.batch_id).sort((a, b) => a.batch_position - b.batch_position);
  if (ordered.length !== batch.vacancy_count) fail('INCOMPLETE_SNAPSHOT_COUNT');
  const ids = new Set(), orders = new Set(), formats = new Set();
  let previousOrder = -Infinity;
  const frozen = ordered.map((item, i) => {
    validateItemState(item.item_state);
    formats.add(snapshotFormat(item));
    if (formats.size > 1) fail('INCONSISTENT_SNAPSHOT_FORMAT');
    if (item.batch_position !== i + 1 || !nonempty(item.application_id) || ids.has(item.application_id)) fail('INCOMPLETE_SNAPSHOT_IDENTITY');
    if (!Number.isSafeInteger(item.application_row_number) || item.application_row_number < 2
      || !Number.isSafeInteger(item.application_sheet_id) || item.application_sheet_id < 0) fail('INCOMPLETE_SOURCE_REFERENCE');
    const order = parsePublicationOrder(item.publication_order);
    if (orders.has(order) || order < previousOrder) fail('INCOMPLETE_SNAPSHOT_ORDER');
    previousOrder = order;
    if (!matchesFrozenVacancy(item)) fail('INCOMPLETE_SNAPSHOT_CONTENT');
    if (item.item_state === ITEM_STATE.SENT && !published(item)) fail('INCOMPLETE_SENT_METADATA');
    ids.add(item.application_id); orders.add(order);
    return Object.freeze(Object.fromEntries(ITEM_FIELDS.map(f => [f, item[f]])));
  });
  if (batch.batch_status === BATCH_STATE.COMPLETED && (!nonempty(batch.started_at) || !nonempty(batch.completed_at)
    || !nonempty(batch.start_telegram_message_id) || !nonempty(batch.end_telegram_message_id)
    || frozen.some(item => item.item_state !== ITEM_STATE.SENT))) fail('INCOMPLETE_COMPLETED_BATCH');
  return Object.freeze({ ...Object.fromEntries(BATCH_FIELDS.map(f => [f, batch[f]])), items: Object.freeze(frozen) });
}
export function persistenceState(c, metadata, response) {
  const values = response.valueRanges;
  if (!Array.isArray(values) || values.length < 3) fail('MISSING_PERSISTENCE_READ');
  const checkbox = values[0].values?.[0]?.[0] ?? false;
  if (checkbox !== false && checkbox !== true && checkbox !== '') fail('INVALID_CONTROL_VALUE');
  const batches = table(values[1].values, BATCH_FIELDS).rows;
  const itemTable = table(values[2].values, LEGACY_ITEM_FIELDS);
  const items = itemTable.rows;
  const ids = new Set();
  for (const batch of batches) {
    if (!nonempty(batch.batch_id) || ids.has(batch.batch_id)) fail('INVALID_BATCH_IDENTITY');
    ids.add(batch.batch_id); validateBatchState(batch.batch_status);
    // Fail closed on any structurally incomplete history, never hide half-created rows.
    reconstructBatch(batch, items);
  }
  for (const item of items) if (!ids.has(item.batch_id)) fail('ORPHAN_FROZEN_ITEM');
  const active = batches.filter(b => b.batch_status !== BATCH_STATE.COMPLETED);
  if (active.length > 1) fail('MULTIPLE_UNFINISHED_BATCHES');
  const claim = properties(metadata, c.claim, true);
  const claimId = values[3]?.values?.[0]?.[0] ?? '';
  if (claim && !ids.has(claimId)) fail('ORPHAN_OR_INCOMPLETE_CLAIM');
  if (active.length && (!claim || claimId !== active[0].batch_id)) fail('MISSING_OR_MISMATCHED_ACTIVE_CLAIM');
  return { control: checkbox === true, batches, items, item_headers: itemTable.headers, claim, claim_batch_id: claimId,
    active: active.length ? reconstructBatch(active[0], items) : null };
}
export function resetRequest(c, metadata) {
  const pos = cellPosition(c.control_cell);
  return writeCells(properties(metadata, c.control).sheetId, pos.row, pos.column, [[false]]);
}
export function inspectPlan(c, metadata, response) {
  const state = persistenceState(c, metadata, response);
  if (state.active) return { kind: 'ACTIVE_BATCH', batch: state.active,
    requests: [], state, metadata, response };
  if (!state.control) return { kind: 'INACTIVE', requests: [], state };
  return { kind: 'READ_LATEST_APPLICATIONS', requests: [], state };
}
export function applicationRows(c, values, state) {
  const { rows } = table(values, [...requiredUpstream, ...APPLICATION_FIELDS]);
  const batches = new Map(state.batches.map(b => [b.batch_id, b]));
  const identities = new Set();
  return rows.map(row => {
    if (nonempty(row.application_id)) {
      if (identities.has(row.application_id)) fail('DUPLICATE_APPLICATION_ID');
      identities.add(row.application_id);
    }
    const claim = nonempty(row.batch_id) ? batches.get(row.batch_id) : null;
    if (nonempty(row.batch_id) && !claim) fail(`ORPHAN_APPLICATION_CLAIM:${row.row_number}`);
    if (nonempty(row.published_at) !== nonempty(row.telegram_message_id)) fail(`INCOMPLETE_APPLICATION_METADATA:${row.row_number}`);
    const savedItems = state.items.filter(item => item.application_id === row.application_id);
    const unfinishedItem = savedItems.find(item => batches.get(item.batch_id)?.batch_status !== BATCH_STATE.COMPLETED);
    return { ...row, project_link: row['Project Website Link'], details_link: row['Original Link'], contact: row['Contact Info'],
      successfully_published: published(row) || savedItems.some(item => item.item_state === ITEM_STATE.SENT && published(item)),
      active_unfinished_batch_id: unfinishedItem?.batch_id ?? (claim && claim.batch_status !== BATCH_STATE.COMPLETED ? claim.batch_id : null) };
  });
}
export function newBatchPlan(c, metadata, state, latestValues, uuid, now) {
  if (!state.control || state.active) fail('NEW_BATCH_NOT_PERMITTED');
  const rows = applicationRows(c, latestValues, state);
  const selected = selectNewBatch(rows);
  if (!selected.ok) return { kind: 'PREFLIGHT_FAILED', errors: selected.errors, requests: [] };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) fail('INVALID_BATCH_UUID');
  const batchId = `wb-${uuid}`;
  const result = createBatchSnapshot(selected.eligible, { batch_id: batchId, config: c });
  if (!result.ok) return { kind: 'PREFLIGHT_FAILED', errors: result.errors, requests: [] };
  if (!result.snapshot) return { kind: 'NO_CANDIDATES', requests: [resetRequest(c, metadata)] };
  if (!Number.isFinite(Date.parse(now))) fail('INVALID_CREATED_AT');
  const snapshot = result.snapshot;
  const app = properties(metadata, c.applications), batchTab = properties(metadata, c.batches), itemTab = properties(metadata, c.items);
  const headers = latestValues[0];
  const source = new Map(rows.map(r => [r.application_id, r]));
  const batch = { ...Object.fromEntries(BATCH_FIELDS.map(f => [f, ''])), batch_id: batchId,
    batch_status: BATCH_STATE.CREATED, created_at: now, vacancy_count: snapshot.vacancy_count,
    workflow_version: c.workflow_version, config_version: c.config_version };
  const frozen = snapshot.items.map(item => ({
    ...Object.fromEntries(ITEM_FIELDS.map(f => [f, ''])), ...item, batch_id: batchId,
    application_sheet_id: app.sheetId, application_row_number: source.get(item.application_id).row_number,
    item_state: item.state,
  }));
  const requests = [];
  // Append only B-owned snapshot columns, atomically with the new batch claim.
  // Existing rows/cells remain unchanged; legacy publish never needs this step.
  const missingItemFields = PRESENTATION_FIELDS.filter(f => !state.item_headers.includes(f));
  const itemHeaders = [...state.item_headers, ...missingItemFields];
  requests.push(...ensureSize(itemTab, itemTab.gridProperties.rowCount, itemHeaders.length));
  if (missingItemFields.length) requests.push(writeCells(itemTab.sheetId, 0, state.item_headers.length, [missingItemFields]));
  // Replace ONLY the exact historical fence ID observed, never an active fence.
  if (state.claim) requests.push({ deleteSheet: { sheetId: state.claim.sheetId } });
  const claimSheetId = Math.max(...metadata.sheets.map(s => s.properties.sheetId)) + 1;
  requests.push({ addSheet: { properties: { sheetId: claimSheetId, title: c.claim, hidden: true,
    gridProperties: { rowCount: 1, columnCount: 1 } } } }, writeCells(claimSheetId, 0, 0, [[batchId]]));
  requests.push(appendRows(batchTab.sheetId, [BATCH_FIELDS.map(f => batch[f])]),
    appendRows(itemTab.sheetId, frozen.map(item => itemHeaders.map(f => item[f] ?? ''))));
  for (const item of frozen) {
    for (const [field, value] of [['batch_id', batchId], ['batch_position', item.batch_position]]) {
      requests.push(writeCells(app.sheetId, item.application_row_number - 1, headers.indexOf(field), [[value]]));
    }
  }
  requests.push(resetRequest(c, metadata));
  // Never split an oversized transaction: keep one all-or-nothing API write.
  if (JSON.stringify({ requests }).length > 1500000) fail('ATOMIC_REQUEST_TOO_LARGE');
  return { kind: 'CREATE_BATCH', batch: reconstructBatch(batch, frozen), requests };
}
