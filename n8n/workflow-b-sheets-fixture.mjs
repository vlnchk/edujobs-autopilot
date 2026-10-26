// Local Google Sheets-shaped fixture. No network/credentials. Atomic commit is
// modeled per the documented API guarantee; this does not prove live isolation.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { visibleLength } from '../workflow-logic/publication-shape.mjs';
import { asString, isPlausibleBareDomain, submittedLinkUrlCandidate, RESERVED_TELEGRAM_PATHS } from '../workflow-logic/deterministic.mjs';
import { apiBase } from './workflow-b-sheets.mjs';

// The shared Workflow A helpers and the domain module exactly as
// n8n/build-workflow-b.mjs embeds them at the start of every Code program.
export const bundledDomain = () => [visibleLength, asString, isPlausibleBareDomain, submittedLinkUrlCandidate].map(String).join('\n')
  + `\nconst RESERVED_TELEGRAM_PATHS = new Set(${JSON.stringify([...RESERVED_TELEGRAM_PATHS])});\n`
  + readFileSync(new URL('./workflow-b-domain.mjs', import.meta.url), 'utf8')
    .replace(/^import \{[^}]*\} from "\.\.\/workflow-logic\/[a-z-]+\.mjs";\n/gm, '').replace(/^export /gm, '');
export const UPSTREAM_HEADERS = ['Timestamp', 'Short Description', 'Project Website Link', 'Original Link', 'Contact Info',
  'application_id', 'processing_status', 'primary_reason', 'review_reason', 'draft_description', 'final_description',
  'normalized_contact_info', 'role_title', 'employer_name', 'project_link_text'];
export const example = (id = 'app-a', order = 10) => ({
  Timestamp: '2026-09-10', 'Short Description': 'Raw source', 'Project Website Link': 'https://project.example',
  'Original Link': 'https://vacancy.example', 'Contact Info': '@editor', application_id: id,
  processing_status: 'FUTURE_STATUS', primary_reason: 'UPSTREAM_REASON', review_reason: 'Evidence for operator',
  draft_description: 'Approved body', project_link_text: 'Approved', final_description: 'Machine artifact', human_decision: 'PUBLISH', publication_order: order,
});
export class SheetFixture {
  constructor(rows = [example()]) {
    this.sheets = [{ properties: { sheetId: 0, title: 'Applications', gridProperties: { rowCount: 100, columnCount: 30 } },
      values: [UPSTREAM_HEADERS, ...rows.map(r => UPSTREAM_HEADERS.map(h => r[h] ?? ''))] }];
    this.calls = []; this.failBeforeCommit = false; this.failAfterCommit = false;
  }
  metadata() { return { sheets: this.sheets.map(s => ({ properties: structuredClone(s.properties) })) }; }
  sheet(title) { return this.sheets.find(s => s.properties.title === title); }
  edit(title, row, field, value) { this.sheet(title).values[row - 1][this.sheet(title).values[0].indexOf(field)] = value; }
  control(c, value) { const m = /^([A-Z]+)(\d+)$/.exec(c.control_cell); const col = [...m[1]].reduce((n, x) => n * 26 + x.charCodeAt(0) - 64, 0) - 1;
    const s = this.sheet(c.control); s.values[Number(m[2]) - 1] ??= []; s.values[Number(m[2]) - 1][col] = value; }
  get(url) {
    this.calls.push({ method: 'GET', url });
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith('/values:batchGet')) return this.metadata();
    return { valueRanges: parsed.searchParams.getAll('ranges').map(range => {
      const m = /^'((?:[^']|'')+)'(?:!([A-Z]+)(\d+))?$/.exec(range); assert.ok(m, range);
      const sheet = this.sheet(m[1].replaceAll("''", "'")); assert.ok(sheet, range);
      if (!m[2]) return { range, values: structuredClone(sheet.values) };
      const col = [...m[2]].reduce((n, x) => n * 26 + x.charCodeAt(0) - 64, 0) - 1;
      return { range, values: [[sheet.values[Number(m[3]) - 1]?.[col] ?? '']] };
    }) };
  }
  commit(requests) {
    this.calls.push({ method: 'POST', requests: structuredClone(requests) });
    if (this.failBeforeCommit) { this.failBeforeCommit = false; throw new Error('SIMULATED_WRITE_FAILURE'); }
    const next = structuredClone(this.sheets);
    const find = id => { const s = next.find(s => s.properties.sheetId === id); assert.ok(s, `missing sheet ${id}`); return s; };
    for (const r of requests) {
      if (r.addSheet) {
        const p = r.addSheet.properties;
        assert.ok(!next.some(s => s.properties.title === p.title || s.properties.sheetId === p.sheetId), 'CLAIM_CONFLICT');
        next.push({ properties: structuredClone(p), values: [] });
      } else if (r.deleteSheet) {
        const s = find(r.deleteSheet.sheetId); assert.notEqual(s.properties.title, 'Applications'); next.splice(next.indexOf(s), 1);
      } else if (r.updateCells || r.appendCells) {
        const op = r.updateCells ?? r.appendCells;
        const s = find(op.start?.sheetId ?? op.sheetId), startRow = op.start?.rowIndex ?? s.values.length, startColumn = op.start?.columnIndex ?? 0;
        for (const [i, row] of op.rows.entries()) {
          s.values[startRow + i] ??= [];
          for (const [j, cell] of row.values.entries()) {
            const v = cell.userEnteredValue;
            s.values[startRow + i][startColumn + j] = v?.stringValue ?? v?.numberValue ?? v?.boolValue ?? v?.formulaValue ?? '';
          }
        }
      } else if (r.appendDimension) {
        const op = r.appendDimension; find(op.sheetId).properties.gridProperties[op.dimension === 'ROWS' ? 'rowCount' : 'columnCount'] += op.length;
      } else assert.ok(r.setDataValidation, `unmodeled request ${JSON.stringify(r)}`);
    }
    this.sheets = next;
    if (this.failAfterCommit) { this.failAfterCommit = false; throw new Error('SIMULATED_LOST_RESPONSE'); }
    return { replies: requests.map(() => ({})) };
  }
}
// Execute the actual generated graph with n8n-shaped values and mocked HTTP.
export async function runGraph(workflow, fixture, env, beforeLatest, telegram, hooks = {}) {
  const output = new Map(), visited = [], byName = new Map(workflow.nodes.map(n => [n.name, n]));
  let name = 'Manual Trigger', input = [{}];
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  while (name) {
    assert.ok(visited.length < 500, 'unexpected loop'); visited.push(name);
    const node = byName.get(name); let branch = 0;
    await hooks.beforeNode?.(name, structuredClone(input));
    const runIndex = output.get(name)?.length ?? 0;
    const $ = key => ({ first: (branch = 0, index) => ({ json: (index === undefined || index === -1 ? output.get(key).at(-1) : output.get(key)[index])[0] }) });
    const evaluate = expression => hooks.evaluateExpression
      ? hooks.evaluateExpression(expression, { $, $json: input[0] }, node)
      : Function('$', '$json', `return (${expression.slice(3, -2)});`)($, input[0]);
    if (node.type.endsWith('.code')) {
      const bindings = { $input: { first: () => ({ json: input[0] }), all: () => input.map(json => ({ json })) },
        $, $env: env, $runIndex: runIndex };
      const result = hooks.executeCode ? await hooks.executeCode(node, bindings)
        : await new AsyncFunction('$input', '$', '$env', '$runIndex', node.parameters.jsCode)(
          bindings.$input, $, env, runIndex);
      input = result.map(r => r.json);
    } else if (node.type.endsWith('.if')) branch = evaluate(node.parameters.conditions.conditions[0].leftValue) ? 0 : 1;
    else if (node.type.endsWith('.crypto')) input = [{ ...input[0], [node.parameters.dataPropertyName]: randomUUID() }];
    else if (node.type.endsWith('.httpRequest')) {
      const url = evaluate(node.parameters.url); assert.ok(url.startsWith(apiBase({ spreadsheet_id: env.GOOGLE_SHEETS_DOCUMENT_ID })));
      if (name === 'Read Latest Applications') await beforeLatest?.(fixture);
      try { input = [node.parameters.method === 'POST' ? fixture.commit(evaluate(node.parameters.jsonBody).requests) : fixture.get(url)]; }
      catch (e) { if (node.onError !== 'continueRegularOutput') throw e; input = [{ error: { message: e.message } }]; }
    } else if (node.type.endsWith('.telegram')) {
      assert.ok(telegram, 'Telegram fake required');
      const resolve = value => typeof value === 'string' && value.startsWith('={{') ? evaluate(value)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)])) : value;
      try { input = await telegram(node, resolve(node.parameters), structuredClone(input)); }
      catch (error) { if (node.onError !== 'continueRegularOutput') throw error; input = [{ error: error.message }]; }
      if (!input.length && node.alwaysOutputData) input = [{}];
    } else assert.ok(node.type.endsWith('.manualTrigger'));
    output.set(name, [...(output.get(name) ?? []), structuredClone(input)]);
    await hooks.afterNode?.(name, branch);
    name = workflow.connections[name]?.main?.[branch]?.[0]?.node;
  }
  return { result: input[0], visited };
}
