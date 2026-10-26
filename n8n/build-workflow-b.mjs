import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { visibleLength } from '../workflow-logic/publication-shape.mjs';
import { asString, isPlausibleBareDomain, submittedLinkUrlCandidate, RESERVED_TELEGRAM_PATHS } from '../workflow-logic/deterministic.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// Explicit portable export; normal builds still require both credential pairs.
const args = process.argv.slice(2);
const credentialFree = args.includes('--credential-free');
const outputs = args.filter(arg => arg !== '--credential-free');
if (outputs.length > 1 || outputs.some(arg => arg.startsWith('--'))
  || credentialFree && (outputs.length !== 1 || resolve(outputs[0]) === join(here, 'workflow-b.json')))
  throw new Error('Usage: node n8n/build-workflow-b.mjs [output.json] [--credential-free]; portable export requires a separate output path');
// n8n Code cannot import adjacent ES modules. Bundle their actual source, with
// module declarations removed, rather than maintaining a second set of rules.
// Shared Workflow A helpers are embedded like Workflow A's builder does.
const shared = [visibleLength, asString, isPlausibleBareDomain, submittedLinkUrlCandidate].map(String).join('\n')
  + `\nconst RESERVED_TELEGRAM_PATHS = new Set(${JSON.stringify([...RESERVED_TELEGRAM_PATHS])});`;
const domain = readFileSync(join(here, 'workflow-b-domain.mjs'), 'utf8')
  .replace(/^import \{[^}]*\} from "\.\.\/workflow-logic\/[a-z-]+\.mjs";\n/gm, '').replace(/^export /gm, '');
const sheets = readFileSync(join(here, 'workflow-b-sheets.mjs'), 'utf8')
  .replace(/^import \{[\s\S]*?\} from '\.\/workflow-b-domain.mjs';\n/, '').replace(/^export /gm, '');
const publication = readFileSync(join(here, 'workflow-b-publication.mjs'), 'utf8')
  .replace(/^import \{[\s\S]*?\} from '\.\/workflow-b-(?:domain|sheets)\.mjs';\n/gm, '').replace(/^export /gm, '');
const bundled = `${shared}\n${domain}\n${sheets}\n${publication}\n`;
function credentialReference(type, prefix) {
  if (credentialFree) return undefined;
  const idKey = `${prefix}_ID`, nameKey = `${prefix}_NAME`;
  const id = process.env[idKey]?.trim(), name = process.env[nameKey]?.trim();
  const missing = [!id && idKey, !name && nameKey].filter(Boolean);
  if (missing.length) throw new Error(`Missing required credential configuration for ${type}: ${missing.join(', ')}`);
  return { [type]: { id, name } };
}
const credentials = credentialReference('googleApi', 'N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL');
// Verified in n8n 2.35.7: Telegram v1.2 description.credentials requires telegramApi.
const telegramCredentials = credentialReference('telegramApi', 'N8N_TELEGRAM_CREDENTIAL');
const nodes = [], connections = {};
function node(name, type, parameters, extra = {}) {
  const result = { id: name.toLowerCase().replaceAll(' ', '-'), name,
    type: `n8n-nodes-base.${type}`, typeVersion: ({ manualTrigger: 1, code: 2, crypto: 1, httpRequest: 4.2, if: 2.2, telegram: 1.2 })[type],
    position: [nodes.length * 240, 0], parameters, ...extra };
  nodes.push(result); return result;
}
const code = (name, body) => node(name, 'code', { mode: 'runOnceForAllItems', jsCode: bundled + body });
function http(name, url, post = false) {
  return node(name, 'httpRequest', { method: post ? 'POST' : 'GET', url,
    authentication: 'predefinedCredentialType', nodeCredentialType: 'googleApi',
    ...(post ? { sendBody: true, specifyBody: 'json', jsonBody: '={{ { requests: $json.requests } }}' } : {}),
    options: { timeout: 60000 } }, { credentials,
    retryOnFail: false, ...(post ? { onError: 'continueRegularOutput' } : {}) });
}
function condition(name, expression) {
  node(name, 'if', { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{ id: `${name}-condition`, leftValue: expression, rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
    combinator: 'and' }, options: {} });
}
function connect(from, to, output = 0) {
  connections[from] ??= { main: [] };
  while (connections[from].main.length <= output) connections[from].main.push([]);
  connections[from].main[output].push({ node: to, type: 'main', index: 0 });
}
node('Manual Trigger', 'manualTrigger', {});
code('Workflow B Configuration', `return [{ json: { config: sheetsConfig($env) } }];`);
http('Read Workbook Metadata', "={{ 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent($('Workflow B Configuration').first().json.config.spreadsheet_id) + '?fields=sheets.properties' }}");
code('Plan Initial Read', `const c = $('Workflow B Configuration').first().json.config;
return [{ json: readPlan(c, $input.first().json) }];`);
http('Read Control And Persistence', '={{ $json.url }}');
code('Inspect Control And Active Batch', `const c = $('Workflow B Configuration').first().json.config;
const metadata = $('Read Workbook Metadata').first().json;
const response = $input.first().json;
const plan = c.mode === 'setup' ? setupPlan(c, metadata, response.valueRanges?.[0]?.values)
  : inspectPlan(c, metadata, response);
return [{ json: plan }];`);
condition('Latest Applications Required', "={{ $json.kind === 'READ_LATEST_APPLICATIONS' }}");
code('Plan Latest Applications Read', `const c = $('Workflow B Configuration').first().json.config;
return [{ json: readPlan(c, $('Read Workbook Metadata').first().json, true) }];`);
http('Read Latest Applications', '={{ $json.url }}');
node('Generate Batch UUID', 'crypto', { action: 'generate', dataPropertyName: 'generated_batch_uuid', encodingType: 'uuid' });
code('Prepare Frozen Batch', `const c = $('Workflow B Configuration').first().json.config;
const plan = newBatchPlan(c, $('Read Workbook Metadata').first().json,
  $('Inspect Control And Active Batch').first().json.state,
  $('Read Latest Applications').first().json.valueRanges?.[0]?.values,
  $input.first().json.generated_batch_uuid, new Date().toISOString());
return [{ json: plan }];`);
condition('Write Required', '={{ $json.requests.length > 0 }}');
http('Atomic Sheets Commit', "={{ 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent($('Workflow B Configuration').first().json.config.spreadsheet_id) + ':batchUpdate' }}", true);
http('Read Metadata After Commit', "={{ 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent($('Workflow B Configuration').first().json.config.spreadsheet_id) + '?fields=sheets.properties' }}");
code('Plan Persistence Verification', `const c = { ...$('Workflow B Configuration').first().json.config, mode: 'run' };
return [{ json: readPlan(c, $input.first().json) }];`);
http('Read Persistence After Commit', '={{ $json.url }}');
code('Verify Commit Or Recover Winner', `const c = { ...$('Workflow B Configuration').first().json.config, mode: 'run' };
const state = persistenceState(c, $('Read Metadata After Commit').first().json, $input.first().json);
const planned = $('Write Required').first().json;
const response = $('Atomic Sheets Commit').first().json;
if (state.active) {
  const overlapping_winner = Boolean(planned.batch && state.active.batch_id !== planned.batch.batch_id);
  return [{ json: { kind: 'ACTIVE_BATCH', batch: state.active,
    control_reset: !state.control, recovered_after_write_error: Boolean(response.error), overlapping_winner,
    publication_confirmed: planned.kind === 'CREATE_BATCH' && !overlapping_winner
      && !state.control && state.active.batch_status === 'CREATED',
    metadata: $('Read Metadata After Commit').first().json, response: $input.first().json } }];
}
if (response.error || state.control || planned.kind === 'CREATE_BATCH') throw new Error('UNCONFIRMED_SHEETS_WRITE: re-run from Manual Trigger; do not retry a cached write');
return [{ json: { kind: planned.kind === 'SETUP' ? 'SETUP_COMPLETE' : planned.kind, control_reset: true } }];`);
code('M2 Result', `const plan = $input.first().json;
return [{ json: { kind: plan.kind, ...(plan.batch ? { batch: plan.batch } : {}), ...(plan.errors ? { errors: plan.errors } : {}) } }];`);
for (const [a, b] of [
  ['Manual Trigger', 'Workflow B Configuration'], ['Workflow B Configuration', 'Read Workbook Metadata'],
  ['Read Workbook Metadata', 'Plan Initial Read'], ['Plan Initial Read', 'Read Control And Persistence'],
  ['Read Control And Persistence', 'Inspect Control And Active Batch'], ['Inspect Control And Active Batch', 'Publication Required'],
  ['Latest Applications Required', 'Plan Latest Applications Read'], ['Plan Latest Applications Read', 'Read Latest Applications'],
  ['Read Latest Applications', 'Generate Batch UUID'], ['Generate Batch UUID', 'Prepare Frozen Batch'],
  ['Prepare Frozen Batch', 'Write Required'], ['Write Required', 'Atomic Sheets Commit'],
  ['Atomic Sheets Commit', 'Read Metadata After Commit'], ['Read Metadata After Commit', 'Plan Persistence Verification'],
  ['Plan Persistence Verification', 'Read Persistence After Commit'], ['Read Persistence After Commit', 'Verify Commit Or Recover Winner'],
]) connect(a, b);
connect('Latest Applications Required', 'Write Required', 1);
connect('Write Required', 'M2 Result', 1);
// Existing batches bypass creation; a new batch must first pass durable read-back.
condition('Publication Required', "={{ $json.kind === 'ACTIVE_BATCH' }}");
condition('Created Batch Confirmed', '={{ $json.publication_confirmed === true }}');
connect('Verify Commit Or Recover Winner', 'Created Batch Confirmed');
connect('Created Batch Confirmed', 'Prepare Whole Frozen Transport');
connect('Created Batch Confirmed', 'Publication No Op', 1);
code('Prepare Whole Frozen Transport', `const c = $('Workflow B Configuration').first().json.config;
const plan = $input.first().json;
if (plan.batch.batch_status === 'PUBLISHING') return [{ json: { kind: 'BATCH_ALREADY_PUBLISHING', batch_id: plan.batch.batch_id } }];
return [{ json: preparePublication(c, plan.metadata, plan.response, telegramConfig($env)) }];`);
condition('Unfinished Publication Exists', "={{ $json.kind === undefined }}");
code('Publication No Op', 'return $input.all();');
code('Plan Application Ack Targets Read', `const context = $input.first().json;
return [{ json: readPlan(context.c, $('Read Workbook Metadata').first().json, true) }];`);
http('Read Application Ack Targets', '={{ $json.url }}');
code('Validate Application Ack Targets', `return [{ json: publicationTargets(
  $('Prepare Whole Frozen Transport').first().json, $('Read Workbook Metadata').first().json,
  $input.first().json.valueRanges?.[0]?.values) }];`);
function telegram(name, resource, operation, parameters = {}, sending = false) {
  return node(name, 'telegram', { resource, operation,
    chatId: "={{ $('Prepare Whole Frozen Transport').first().json.config.chat_id }}", ...parameters },
    { credentials: telegramCredentials, retryOnFail: false,
      alwaysOutputData: true, ...(sending ? { onError: 'continueRegularOutput' } : {}) });
}
telegram('Telegram Get Chat', 'chat', 'get');
code('Validate Telegram Destination', `const context = $('Validate Application Ack Targets').first().json;
validateTelegramChat(context.config, $input.first().json);
return [{ json: context }];`);
telegram('Telegram Get Administrators', 'chat', 'administrators');
code('Prepare Publishing Commit', `const context = $('Validate Telegram Destination').first().json;
validateTelegramAdministrators(context.config, $input.all().map(i => i.json));
return [{ json: beginPublication(context) }];`);
const publicationCommitUrl = "={{ 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent($('Workflow B Configuration').first().json.config.spreadsheet_id) + ':batchUpdate' }}";
http('Persist Publishing Status', publicationCommitUrl, true);
code('Confirm Publishing Status', `return [{ json: confirmSheetsCommit($input.first().json,
  $('Prepare Publishing Commit').first().json) }];`);
code('Publication Cursor', `return [{ json: currentPublication($input.first().json) }];`);
telegram('Telegram Send Message', 'message', 'sendMessage', {
  text: '={{ $json.sequence[$json.cursor].text }}', replyMarkup: 'none',
  additionalFields: { parse_mode: 'HTML', disable_web_page_preview: true,
    disable_notification: false, appendAttribution: false },
}, true);
code('Plan Telegram Acknowledgement', `const context = $('Publication Cursor').first(0, $runIndex).json;
const response = $input.first().json;
try { return [{ json: { ...acknowledgementPlan(context, response), stopped: false } }]; }
catch { return [{ json: { ...context, stopped: true, ...classifyTelegramFailure(response) } }]; }`);
condition('Telegram Acknowledgement Valid', '={{ $json.stopped === false }}');
code('Validated Acknowledgement Plan', 'return $input.all();');
http('Persist Telegram Acknowledgement', publicationCommitUrl, true);
code('Confirm Telegram Acknowledgement', `const plan = $('Validated Acknowledgement Plan').first(0, $runIndex).json;
try { return [{ json: { ...confirmSheetsCommit($input.first().json, plan), stopped: false } }]; }
catch {
  const context = { ...plan, cursor: plan.cursor - 1, batch: { ...plan.batch, batch_status: 'PUBLISHING' } };
  return [{ json: { ...context, stopped: true,
    url: apiBase(context.c) + '/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&ranges=' + encodeURIComponent(quotedTab(context.c.batches)) } }];
}`);
condition('Acknowledgement Saved', '={{ $json.stopped === false }}');
http('Read Batch After Unconfirmed Write', '={{ $json.url }}');
code('Plan Unconfirmed Write Stop', `return [{ json: stopAfterUnconfirmedWrite(
  $('Confirm Telegram Acknowledgement').first(0, -1).json, $input.first().json) }];`);
condition('More Publication Messages', '={{ $json.cursor < $json.sequence.length }}');
code('Publication Completed', `const context = $input.first().json;
if (context.batch.batch_status !== 'COMPLETED' || context.cursor !== context.sequence.length) throw new Error('INCOMPLETE_PUBLICATION');
return [{ json: { kind: 'COMPLETED', batch: reconstructBatch(context.batch, context.batch.items) } }];`);
code('Plan Publication Stop', `const context = $input.first().json;
return [{ json: publicationStopPlan(context, context.failure_code) }];`);
http('Persist Publication Stop', publicationCommitUrl, true);
code('Publication Stopped', `const plan = $('Plan Publication Stop').first().json;
try { confirmSheetsCommit($input.first().json, plan); }
catch { throw new Error('PUBLICATION_STOP_WRITE_UNCONFIRMED: check n8n UI for stopped executions, clean Telegram, then manually set a stuck PUBLISHING batch to FAILED'); }
throw new Error(plan.failure_code + ': FAILED; manual Telegram cleanup and full-batch restart from START required');`);
for (const [a, b] of [
  ['Publication Required', 'Prepare Whole Frozen Transport'],
  ['Prepare Whole Frozen Transport', 'Unfinished Publication Exists'],
  ['Unfinished Publication Exists', 'Plan Application Ack Targets Read'],
  ['Plan Application Ack Targets Read', 'Read Application Ack Targets'],
  ['Read Application Ack Targets', 'Validate Application Ack Targets'],
  ['Validate Application Ack Targets', 'Telegram Get Chat'],
  ['Telegram Get Chat', 'Validate Telegram Destination'],
  ['Validate Telegram Destination', 'Telegram Get Administrators'],
  ['Telegram Get Administrators', 'Prepare Publishing Commit'],
  ['Prepare Publishing Commit', 'Persist Publishing Status'], ['Persist Publishing Status', 'Confirm Publishing Status'],
  ['Confirm Publishing Status', 'Publication Cursor'], ['Publication Cursor', 'Telegram Send Message'],
  ['Telegram Send Message', 'Plan Telegram Acknowledgement'],
  ['Plan Telegram Acknowledgement', 'Telegram Acknowledgement Valid'],
  ['Telegram Acknowledgement Valid', 'Validated Acknowledgement Plan'],
  ['Validated Acknowledgement Plan', 'Persist Telegram Acknowledgement'],
  ['Persist Telegram Acknowledgement', 'Confirm Telegram Acknowledgement'],
  ['Confirm Telegram Acknowledgement', 'Acknowledgement Saved'], ['Acknowledgement Saved', 'More Publication Messages'],
  ['Read Batch After Unconfirmed Write', 'Plan Unconfirmed Write Stop'], ['Plan Unconfirmed Write Stop', 'Plan Publication Stop'],
  ['More Publication Messages', 'Publication Cursor'],
  ['Plan Publication Stop', 'Persist Publication Stop'], ['Persist Publication Stop', 'Publication Stopped'],
]) connect(a, b);
connect('Publication Required', 'Latest Applications Required', 1);
connect('Unfinished Publication Exists', 'Publication No Op', 1);
connect('Telegram Acknowledgement Valid', 'Plan Publication Stop', 1);
connect('Acknowledgement Saved', 'Read Batch After Unconfirmed Write', 1);
connect('More Publication Messages', 'Publication Completed', 1);
const workflow = {
  id: 'edujobs-workflow-b', name: 'EduJobs v2 · Telegram Publisher', nodes, pinData: {}, connections,
  active: false, settings: { executionOrder: 'v1' },
  versionId: '00000000-0000-4000-8000-000000000000',
  meta: { templateCredsSetupCompleted: false }, tags: [],
};
const outputPath = outputs[0] ? resolve(process.cwd(), outputs[0]) : join(here, 'workflow-b.json');
writeFileSync(outputPath, JSON.stringify(workflow, null, 2) + '\n');
process.stdout.write(`Generated Workflow B JSON at ${outputPath}\n`);
