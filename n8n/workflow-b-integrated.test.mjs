import { credentialEnv } from './workflow-b-credentials-fixture.mjs';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyIntegratedWorkflow } from './workflow-b-integrated-fixture.mjs';
import { sheetsConfig } from './workflow-b-sheets.mjs';
import { SheetFixture, runGraph } from './workflow-b-sheets-fixture.mjs';

const directory = mkdtempSync(join(tmpdir(), 'workflow-b-m5-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const builder = fileURLToPath(new URL('./build-workflow-b.mjs', import.meta.url));
const artifact = join(directory, 'workflow.json');
execFileSync(process.execPath, [builder, artifact], { env: credentialEnv });
const workflow = JSON.parse(readFileSync(artifact, 'utf8'));

test('M5 generated setup → human review → run → publication/failure/full retry → history', async () => {
  await verifyIntegratedWorkflow(workflow);
});

test('M5 configuration defaults and complete supported-mode boundary', async () => {
  const defaults = sheetsConfig({ GOOGLE_SHEETS_DOCUMENT_ID: 'synthetic-m5' });
  assert.deepEqual(defaults, { spreadsheet_id: 'synthetic-m5', applications: 'Applications', review: 'Review Queue',
    archive: 'Archive', control: 'Control', batches: 'Publication Batches', items: 'Publication Batch Items',
    claim: '_Workflow B Claim', control_cell: 'B2', details_column: 'Original Link',
    MAX_PUBLICATION_DESCRIPTION_CHARS: 900, workflow_version: 'workflow-b-presentation-v5', config_version: 'presentation-v5', mode: 'run' });
  for (const mode of ['setup', 'run']) assert.equal(sheetsConfig({ GOOGLE_SHEETS_DOCUMENT_ID: 'synthetic-m5', WORKFLOW_B_MODE: mode }).mode, mode);
  for (const change of [{ GOOGLE_SHEETS_DOCUMENT_ID: '' }, { WORKFLOW_B_MODE: 'resume' },
    { WORKFLOW_B_MODE: 'PUBLISH' }, { MAX_PUBLICATION_DESCRIPTION_CHARS: '0' },
    { MAX_PUBLICATION_DESCRIPTION_CHARS: 'NaN' }, { MAX_PUBLICATION_DESCRIPTION_CHARS: '1.5' },
    { WORKFLOW_B_CONTROL_CELL: 'A1' }, { WORKFLOW_B_ARCHIVE_TAB: 'Applications' },
    { WORKFLOW_B_DETAILS_LINK_COLUMN: 'Project Website Link' }]) {
    const f = new SheetFixture();
    await assert.rejects(runGraph(workflow, f, { GOOGLE_SHEETS_DOCUMENT_ID: 'synthetic-m5', ...change }), /INVALID_|MISSING_|O005_/);
    assert.deepEqual(f.calls, [], 'invalid configuration stops before external I/O');
  }
});

test('M5 partial Google references fail without producing an artifact', () => {
  for (const env of [{ N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID: 'synthetic-only' },
    { N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_NAME: 'Synthetic only' }]) {
    const result = spawnSync(process.execPath, [builder, join(directory, 'invalid.json')], { env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing required credential configuration for googleApi: N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_/);
    assert.equal(existsSync(join(directory, 'invalid.json')), false);
  }
});

test('M5 production modules and generated graph have only the contracted dependencies', () => {
  const sources = ['domain', 'sheets', 'publication'].map(name => readFileSync(new URL(`./workflow-b-${name}.mjs`, import.meta.url), 'utf8'));
  assert.deepEqual(sources.flatMap(source => [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1])),
    ['../workflow-logic/publication-shape.mjs', '../workflow-logic/deterministic.mjs', './workflow-b-domain.mjs', './workflow-b-domain.mjs', './workflow-b-sheets.mjs']);
  for (const source of sources) assert.doesNotMatch(source, /\b(?:fetch|require|import|eval)\s*\(|XMLHttpRequest|WebSocket|https?:\/\/(?:api\.openai|api\.telegram)/);
  for (const node of workflow.nodes) {
    assert.equal(node.disabled, undefined);
    assert.ok(['manualTrigger', 'code', 'if', 'crypto', 'httpRequest', 'telegram'].includes(node.type.replace('n8n-nodes-base.', '')));
    if (node.type.endsWith('.code')) assert.doesNotMatch(node.parameters.jsCode, /\b(?:fetch|require|import|eval)\s*\(|setTimeout\s*\(|setInterval\s*\(/);
  }
  assert.doesNotMatch(JSON.stringify(workflow), /deleteMessage|editMessage|openai|langchain|publisherRecord|acknowledgedCursor|N8N_API_CREDENTIAL|WORKFLOW_B_PUBLISHER_TAB/i);
});

test('M5 hygiene checker fails closed and never prints a matched value', () => {
  const path = join(directory, 'synthetic-hygiene.txt');
  const synthetic = '123456789:' + 'A'.repeat(35);
  writeFileSync(path, synthetic);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./verify-workflow-b-hygiene.mjs', import.meta.url)), path],
    { encoding: 'utf8', env: {} });
  assert.equal(result.status, 1);
  assert.equal((result.stdout + result.stderr).includes(synthetic), false);
  assert.match(result.stderr, /Secret-pattern match; inspect privately:/);
  rmSync(path);
});

test('M5 actual runtime config and secret canaries never become builder-time values', () => {
  const env = { ...credentialEnv, GOOGLE_SHEETS_DOCUMENT_ID: 'm5-runtime-sheet-canary', WORKFLOW_B_MODE: 'run',
    WORKFLOW_B_TELEGRAM_CHAT_ID: '-100987654321', WORKFLOW_B_TELEGRAM_EXPECTED_BOT_ID: '999',
    MAX_PUBLICATION_DESCRIPTION_CHARS: '999', OPENAI_API_KEY: 'm5-secret-canary', TELEGRAM_BOT_TOKEN: 'm5-token-canary' };
  const path = join(directory, 'runtime-env.json');
  const result = spawnSync(process.execPath, [builder, path], { env, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(readFileSync(path, 'utf8'), readFileSync(artifact, 'utf8'));
  for (const canary of Object.values(env).filter(v => v.includes('canary'))) {
    assert.equal((result.stdout + result.stderr).includes(canary), false, 'canary leaked in builder output');
  }
});

for (const mode of ['prepare', 'publish']) test(`legacy ${mode} fails with migration instructions before I/O`, async () => {
  const f = new SheetFixture(), before = structuredClone(f.sheets);
  await assert.rejects(runGraph(workflow, f, { GOOGLE_SHEETS_DOCUMENT_ID: 'synthetic', WORKFLOW_B_MODE: mode }),
    /WORKFLOW_B_MODE_MIGRATION_REQUIRED: Set WORKFLOW_B_MODE=run once/);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.sheets, before);
});
