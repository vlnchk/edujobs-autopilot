import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { verifyIntegratedWorkflow, verifyHyperlinkWorkflow } from './workflow-b-integrated-fixture.mjs';
import { bundledDomain } from './workflow-b-sheets-fixture.mjs';
const require = createRequire(import.meta.url);
const version = execFileSync('n8n', ['--version'], { encoding: 'utf8' }).trim();
assert.equal(version, '2.35.7');
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const workflow = Array.isArray(input) ? input[0] : input;
// Explicit verification mode only; a bound artifact may never silently pass
// with missing references. Portable imports intentionally need UI selection.
const credentialFree = process.argv.includes('--credential-free');
if (process.argv[3] && process.argv[3] !== '--credential-free') {
  const generated = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  for (const key of ['nodes', 'connections', 'settings', 'active', 'name', 'id'])
    assert.deepEqual(workflow[key], generated[key], `import/export preserved ${key}`);
}
assert.equal(workflow.active, false);
assert.equal(workflow.name, 'EduJobs v2 · Telegram Publisher');
assert.equal(workflow.nodes.length, 47);
const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
const { extendSyntax } = require(join(root, 'n8n/node_modules/n8n-workflow/dist/cjs/extensions/expression-extension.js'));
const nodeRoot = join(root, 'n8n/node_modules/n8n-nodes-base/dist/nodes');
const classes = { manualTrigger: ['ManualTrigger/ManualTrigger.node.js', 'ManualTrigger'],
  code: ['Code/Code.node.js', 'Code'], if: ['If/If.node.js', 'If'],
  httpRequest: ['HttpRequest/HttpRequest.node.js', 'HttpRequest'], crypto: ['Crypto/Crypto.node.js', 'Crypto'], telegram: ['Telegram/Telegram.node.js', 'Telegram'] };
const names = new Set(workflow.nodes.map(n => n.name));
let expressions = 0, programs = 0;
for (const node of workflow.nodes) {
  const type = node.type.replace('n8n-nodes-base.', ''); assert.ok(classes[type]);
  const [file, className] = classes[type]; const definition = new (require(join(nodeRoot, file))[className])();
  const nodeDefinition = definition.nodeVersions?.[node.typeVersion] ?? definition;
  const versions = nodeDefinition.description.version;
  assert.ok(Array.isArray(versions) ? versions.includes(node.typeVersion) : versions === node.typeVersion, `${type} version ${node.typeVersion}`);
  if (node.parameters.jsCode) { new Function(node.parameters.jsCode); programs++; }
  function checkExpressions(value) {
    if (typeof value === 'string' && value.startsWith('={{')) { extendSyntax(value); expressions++; }
    else if (value && typeof value === 'object') Object.values(value).forEach(checkExpressions);
  }
  checkExpressions(node.parameters);
  if (type === 'telegram') {
    assert.equal(node.typeVersion, 1.2);
    assert.deepEqual(nodeDefinition.description.credentials, [{ name: 'telegramApi', required: true }]);
    if (credentialFree) assert.equal(node.credentials, undefined);
    else {
      assert.deepEqual(Object.keys(node.credentials ?? {}), ['telegramApi']);
      assert.ok(node.credentials.telegramApi.id?.trim());
      assert.ok(node.credentials.telegramApi.name?.trim());
    }
    assert.ok(['get', 'administrators', 'sendMessage'].includes(node.parameters.operation));
    assert.equal(node.retryOnFail, false);
    if (node.parameters.operation === 'sendMessage') assert.deepEqual(node.parameters.additionalFields,
      { parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: false, appendAttribution: false });
  }
  if (type === 'httpRequest') {
    if (credentialFree) assert.equal(node.credentials, undefined);
    else {
      assert.deepEqual(Object.keys(node.credentials ?? {}), ['googleApi']);
      assert.ok(node.credentials.googleApi.id?.trim());
      assert.ok(node.credentials.googleApi.name?.trim());
    }
    assert.equal(node.parameters.nodeCredentialType, 'googleApi'); assert.equal(node.retryOnFail, false);
    assert.match(node.parameters.url, /sheets\.googleapis\.com|\$json\.url/);
  }

}
for (const [from, branches] of Object.entries(workflow.connections)) {
  assert.ok(names.has(from)); for (const target of branches.main.flat()) assert.ok(names.has(target.node));
}
assert.doesNotMatch(JSON.stringify(workflow), /api\.telegram|api\.openai|langchain|BEGIN PRIVATE|botToken/);
// Execute the renderer in the installed n8n runner's own hardened VM wrapper,
// without constructing a runner connection, credentials, or any network client.
const { JsTaskRunner } = require(join(root, 'n8n/node_modules/@n8n/task-runner/dist/js-task-runner/js-task-runner.js'));
const runner = Object.create(JsTaskRunner.prototype);
runner.taskTimeout = 5;
const domain = bundledDomain();
for (const node of workflow.nodes.filter(n => n.type.endsWith('.code')))
  assert.ok(node.parameters.jsCode.startsWith(domain), 'artifact embeds exact current domain implementation');
const href = 'https://hh.ru/vacancy/137336583?hhtmFrom=vacancy_search_list';
const sandboxResult = await runner.runCode({
  code: domain + '; return { link: detailsLink(' + JSON.stringify(href) + '), rendered: renderDetailsLink(' + JSON.stringify(href) + ') };',
  additionalProperties: {},
}, new AbortController().signal);
assert.equal(sandboxResult.link.href, href);
assert.equal(sandboxResult.link.text, 'hh.ru/vacancy/137336583');
assert.equal(sandboxResult.rendered, `[hh.ru/vacancy/137336583](${href})`);
const transportSource = readFileSync(new URL('./workflow-b-publication.mjs', import.meta.url), 'utf8')
  .replace(/^import \{[\s\S]*?\} from '\.\/workflow-b-(?:domain|sheets)\.mjs';\n/gm, '').replace(/^export /gm, '');
const html = await runner.runCode({ code: domain + '\n' + transportSource + `
  const config = telegramConfig({ WORKFLOW_B_TELEGRAM_CHAT_ID: '-1001234567890', WORKFLOW_B_TELEGRAM_EXPECTED_BOT_ID: '222' });
  const item = { batch_position: 1, draft_description: '*plain* <b>literal</b>', details_link: 'https://example.test/job?x=1&x=2', contact: '@editor' };
  item.rendered_text = renderVacancy(item);
  validateTelegramAdministrators(config, [{ status: 'administrator', can_post_messages: true, user: { id: 222, is_bot: true } }]);
  return encodeFrozenVacancy(item, config).text;`, additionalProperties: {} }, new AbortController().signal);
assert.ok(html.includes('*plain* &lt;b&gt;literal&lt;/b&gt;'));
assert.ok(html.includes('<a href="https://example.test/job?x=1&amp;x=2">example.test/job</a>'));
const sheetsSource = readFileSync(new URL('./workflow-b-sheets.mjs', import.meta.url), 'utf8')
  .replace(/^import \{[\s\S]*?\} from '\.\/workflow-b-domain.mjs';\n/, '').replace(/^export /gm, '');
const retryResult = await runner.runCode({ code: domain + '\n' + sheetsSource + '\n' + transportSource + `
  const context = {
    batch: { batch_id: 'wb-synthetic', batch_status: 'FAILED', start_telegram_message_id: 123,
      started_at: '2026-09-19T10:00:00Z', items: [{ application_id: 'app-a', rendered_text: 'frozen',
        item_state: 'SENT', telegram_message_id: 124, telegram_message_url: 'old', published_at: 'old' }] },
    cursor: 0, sequence: [{ kind: 'START' }],
    application_targets: [{ sheet_id: 0, headers: APPLICATION_FIELDS, row: 2 }],
    item_targets: [{ sheet_id: 5, headers: ITEM_FIELDS, row: 2 }],
    batch_target: { sheet_id: 4, headers: BATCH_FIELDS, row: 2 },
  };
  const plan = beginPublication(context);
  return { cursor: plan.cursor, batch: plan.batch, requests: plan.requests.length,
    rate: classifyTelegramFailure({ ok: false, error_code: 429, description: 'Rejected', parameters: { retry_after: 17 } }),
    native: classifyTelegramFailure({ error: '429 retry_after=17' }) };
`, additionalProperties: {} }, new AbortController().signal);
assert.equal(retryResult.cursor, 0); assert.equal(retryResult.batch.batch_status, 'PUBLISHING');
assert.equal(retryResult.batch.start_telegram_message_id, ''); assert.equal(retryResult.requests, 14);
assert.equal(retryResult.batch.items[0].item_state, 'NOT_SENT');
assert.equal(retryResult.batch.items[0].telegram_message_id, '');
assert.equal(retryResult.batch.items[0].rendered_text, 'frozen');
assert.equal(retryResult.rate.failure_code, 'TELEGRAM_REJECTED_429');
assert.equal(retryResult.native.failure_code, 'TELEGRAM_ACK_UNCERTAIN');
// Execute the unmodified generated programs in the installed hardened wrapper.
// The graph scheduler, $input/$ lookup bindings, Sheets and Telegram are mocks;
// this is not a live n8n workflow execution or a task-broker integration test.
const { Expression } = require(join(root, 'n8n/node_modules/n8n-workflow/dist/cjs/expression.js'));
const expression = new Expression({});
const executedPrograms = new Set(), evaluatedExpressions = new Set();
const runtimeHooks = {
  executeCode: async (node, bindings) => {
    try {
      return structuredClone(await runner.runCode({ code: node.parameters.jsCode,
        additionalProperties: bindings }, new AbortController().signal));
    } catch (error) {
      // n8n ExecutionError splits "CODE: detail" into description + message.
      // Preserve both for the same scenario assertions used by the local runner.
      throw new Error([error.description, error.message].filter(Boolean).join(': '));
    } finally { executedPrograms.add(node.name); }
  },
  evaluateExpression: (value, bindings, node) => {
    const result = expression.resolveSimpleParameterValue(value, bindings);
    evaluatedExpressions.add(node.name + ':' + value);
    return result;
  },
};
const integrated = await verifyIntegratedWorkflow(workflow, runtimeHooks);
const hyperlinks = await verifyHyperlinkWorkflow(workflow, runtimeHooks);
assert.equal(executedPrograms.size, programs);
assert.equal(evaluatedExpressions.size, expressions);
console.log(JSON.stringify({ m5_integrated: integrated, hyperlinks, sandbox_programs_executed: executedPrograms.size,
  runtime_expressions_evaluated: evaluatedExpressions.size, node_version: process.version,
  m4_sandbox_full_retry: true, m3_sandbox_transport: true,
  n8n_version: version, imported_nodes: workflow.nodes.length, code_programs: programs, expressions,
  inactive: true, credential_free: credentialFree, live_api_calls: 0, o005_sandbox_render: true }));
