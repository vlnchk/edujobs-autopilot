import { credentialEnv } from './workflow-b-credentials-fixture.mjs';
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const generatedDirectory = mkdtempSync(join(tmpdir(), "edujobs-workflow-b-build-"));
after(() => rmSync(generatedDirectory, { recursive: true, force: true }));

// No inherited credentials, .env files, services, or external packages are needed.
const generation = spawnSync(process.execPath, [join(here, "build-workflow-b.mjs"), "workflow-b.json"], {
  cwd: generatedDirectory,
  encoding: "utf8",
  env: credentialEnv,
  timeout: 10000,
});
assert.equal(generation.status, 0, `${generation.error ?? ""}\n${generation.stderr}`);
const generated = readFileSync(join(generatedDirectory, "workflow-b.json"), "utf8");
const workflow = JSON.parse(generated);

test("builder executes successfully with synthetic credential references and supports a relative output path", () => {
  assert.equal(generation.status, 0);
  assert.equal(generation.stderr, "");
  assert.match(generation.stdout, /Generated Workflow B JSON at /);
});

test("artifact has the established n8n workflow structure", () => {
  assert.equal(workflow.id, "edujobs-workflow-b");
  assert.equal(workflow.name, "EduJobs v2 · Telegram Publisher");
  assert.match(workflow.versionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(workflow.settings, { executionOrder: "v1" });
  assert.equal(workflow.nodes.length, 47);
  const [node] = workflow.nodes;
  assert.equal(node.id, "manual-trigger");
  assert.equal(node.name, "Manual Trigger");
  assert.equal(node.typeVersion, 1);
  assert.deepEqual(node.position, [0, 0]);
  const names = new Set(workflow.nodes.map(n => n.name));
  for (const [source, branches] of Object.entries(workflow.connections)) {
    assert.ok(names.has(source));
    for (const target of branches.main.flat()) assert.ok(names.has(target.node));
  }
  assert.equal(workflow.connections['Manual Trigger'].main[0][0].node, 'Workflow B Configuration');
});

test("generated workflow is inactive by default", () => {
  assert.equal(workflow.active, false);
});

test("M0 structural security boundary permits authorized Google and native Telegram integration", () => {
  const allowed = ['manualTrigger', 'code', 'if', 'crypto', 'httpRequest', 'telegram'];
  assert.ok(workflow.nodes.every(n => allowed.includes(n.type.replace('n8n-nodes-base.', ''))));
  assert.deepEqual(workflow.nodes[0].parameters, {});
  assert.doesNotMatch(generated, /api\.openai|api\.telegram|anthropic|gemini|langchain|botToken/i);
});

test("artifact contains no credential secrets, production identifiers, or hidden payloads", () => {
  // The M0 envelope stays closed; M2 code and requests live in visible node parameters.
  assert.deepEqual(Object.keys(workflow).sort(), [
    "active", "connections", "id", "meta", "name", "nodes", "pinData", "settings", "tags", "versionId",
  ]);
  assert.deepEqual(Object.keys(workflow.nodes[0]).sort(), [
    "id", "name", "parameters", "position", "type", "typeVersion",
  ]);
  assert.deepEqual(workflow.pinData, {});
  assert.deepEqual(workflow.meta, { templateCredsSetupCompleted: false });
  assert.deepEqual(workflow.tags, []);
  assert.doesNotMatch(generated, /api[_-]?key|access[_-]?token|bot[_-]?token|private[_-]?key|password|authorization|-----BEGIN/i);
});

test("generation is deterministic; credential refs bind explicitly and resource config stays runtime-only", () => {
  const outputPath = join(generatedDirectory, "workflow-b-repeat.json");
  const result = spawnSync(process.execPath, [join(here, "build-workflow-b.mjs"), outputPath], {
    cwd: generatedDirectory,
    encoding: "utf8",
    timeout: 10000,
    env: {
      N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID: "synthetic-google-id",
      N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_NAME: "Synthetic Google Credential",
      N8N_TELEGRAM_CREDENTIAL_ID: "synthetic-telegram-id",
      N8N_TELEGRAM_CREDENTIAL_NAME: "Synthetic Telegram Credential",
      N8N_OPENAI_CREDENTIAL_ID: "synthetic-openai-id",
      N8N_OPENAI_CREDENTIAL_NAME: "Synthetic OpenAI Credential",
      TELEGRAM_BOT_TOKEN: "synthetic-token",
      TELEGRAM_CHAT_ID: "synthetic-chat",
      GOOGLE_SPREADSHEET_ID: "synthetic-sheet",
    },
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
  const configured = JSON.parse(readFileSync(outputPath, "utf8"));
  for (const node of configured.nodes.filter(n => n.type.endsWith('.httpRequest'))) {
    assert.deepEqual(node.credentials, { googleApi: { id: 'synthetic-google-id', name: 'Synthetic Google Credential' } });
  }
  for (const node of configured.nodes.filter(n => n.type.endsWith('.telegram'))) {
    assert.deepEqual(node.credentials, { telegramApi: { id: 'synthetic-telegram-id', name: 'Synthetic Telegram Credential' } });
  }
  assert.deepEqual(configured, workflow);
  assert.doesNotMatch(JSON.stringify(configured), /synthetic-sheet|synthetic-chat|synthetic-token|synthetic-openai/);
  const repeat = spawnSync(process.execPath, [join(here, 'build-workflow-b.mjs'), outputPath], {
    cwd: generatedDirectory, encoding: 'utf8', env: credentialEnv, timeout: 10000,
  });
  assert.equal(repeat.status, 0);
  assert.equal(readFileSync(outputPath, 'utf8'), generated);
});

const googleNames = [
  'Read Workbook Metadata', 'Read Control And Persistence', 'Read Latest Applications',
  'Atomic Sheets Commit', 'Read Metadata After Commit', 'Read Persistence After Commit',
  'Read Application Ack Targets', 'Persist Publishing Status', 'Persist Telegram Acknowledgement',
  'Read Batch After Unconfirmed Write', 'Persist Publication Stop',
];
const telegramNames = ['Telegram Get Chat', 'Telegram Get Administrators', 'Telegram Send Message'];

test('all 11 Google-authenticated HTTP nodes persist the configured ID and name', () => {
  const nodes = workflow.nodes.filter(n => n.type === 'n8n-nodes-base.httpRequest'
    && n.parameters.authentication === 'predefinedCredentialType' && n.parameters.nodeCredentialType === 'googleApi');
  assert.deepEqual(nodes.map(n => n.name).sort(), [...googleNames].sort());
  for (const node of nodes) assert.deepEqual(node.credentials, {
    googleApi: { id: credentialEnv.N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID,
      name: credentialEnv.N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_NAME },
  });
});

test('all three native Telegram nodes persist the same configured ID and name', () => {
  const nodes = workflow.nodes.filter(n => n.type === 'n8n-nodes-base.telegram');
  assert.deepEqual(nodes.map(n => n.name).sort(), [...telegramNames].sort());
  for (const node of nodes) assert.deepEqual(node.credentials, {
    telegramApi: { id: credentialEnv.N8N_TELEGRAM_CREDENTIAL_ID,
      name: credentialEnv.N8N_TELEGRAM_CREDENTIAL_NAME },
  });
});

test('no credential-dependent node is omitted and unrelated nodes have no bindings', () => {
  const expected = new Set([...googleNames, ...telegramNames]);
  for (const node of workflow.nodes) {
    const dependent = node.type === 'n8n-nodes-base.telegram'
      || Boolean(node.parameters.nodeCredentialType)
      || Boolean(node.parameters.authentication && node.parameters.authentication !== 'none');
    assert.equal(dependent, expected.has(node.name), node.name);
    assert.equal(Boolean(node.credentials), dependent, node.name);
    if (dependent) {
      assert.equal(Object.keys(node.credentials).length, 1);
      for (const ref of Object.values(node.credentials)) {
        assert.ok(ref.id.trim(), node.name);
        assert.ok(ref.name.trim(), node.name);
      }
    }
  }
});

for (const prefix of ['N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL', 'N8N_TELEGRAM_CREDENTIAL']) {
  for (const suffixes of [['ID'], ['NAME'], ['ID', 'NAME']]) {
    for (const value of [undefined, '', ' \t ']) {
      test(`${prefix}: missing ${suffixes.join('/')} (${JSON.stringify(value)}) fails before writing`, () => {
        const env = { ...credentialEnv };
        for (const suffix of suffixes) {
          if (value === undefined) delete env[`${prefix}_${suffix}`];
          else env[`${prefix}_${suffix}`] = value;
        }
        const path = join(generatedDirectory, 'invalid.json');
        const result = spawnSync(process.execPath, [join(here, 'build-workflow-b.mjs'), path],
          { encoding: 'utf8', env, timeout: 10000 });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Missing required credential configuration/);
        for (const suffix of suffixes) assert.ok(result.stderr.includes(`${prefix}_${suffix}`));
        assert.equal(existsSync(path), false);
        // A failed rebuild must not replace a previously generated artifact either.
        const rebuild = spawnSync(process.execPath, [join(here, 'build-workflow-b.mjs'), join(generatedDirectory, 'workflow-b.json')],
          { encoding: 'utf8', env, timeout: 10000 });
        assert.notEqual(rebuild.status, 0);
        assert.equal(readFileSync(join(generatedDirectory, 'workflow-b.json'), 'utf8'), generated);
      });
    }
  }
}

test('obsolete n8n API credential references have no effect on generation', () => {
  const outputPath = join(generatedDirectory, 'obsolete.json');
  const result = spawnSync(process.execPath, [join(here, 'build-workflow-b.mjs'), outputPath], {
    encoding: 'utf8', env: { ...credentialEnv, N8N_API_CREDENTIAL_ID: 'synthetic-obsolete-only-id' }, timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(outputPath, 'utf8'), generated);
});

test('explicit portable export omits all credential references and ignores ambient builder/runtime values', () => {
  let previous;
  for (const env of [{}, { ...credentialEnv, GOOGLE_SHEETS_DOCUMENT_ID: 'portable-sheet-canary',
    WORKFLOW_B_TELEGRAM_CHAT_ID: '-100987654321', TELEGRAM_BOT_TOKEN: 'portable-token-canary' }]) {
    const outputPath = join(generatedDirectory, 'portable.json');
    const result = spawnSync(process.execPath, [join(here, 'build-workflow-b.mjs'), outputPath, '--credential-free'],
      { encoding: 'utf8', env, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(outputPath, 'utf8'), portable = JSON.parse(text);
    assert.equal(portable.active, false);
    assert.equal(portable.nodes.some(node => Object.hasOwn(node, 'credentials')), false);
    const unbound = JSON.parse(generated);
    for (const node of unbound.nodes) delete node.credentials;
    assert.deepEqual(portable, unbound);
    assert.doesNotMatch(text, /synthetic-google|synthetic-telegram|portable-sheet-canary|portable-token-canary/);
    if (previous) assert.equal(text, previous);
    previous = text;
  }
});
test('portable export requires a separate path and never overwrites the private default artifact', () => {
  const privatePath = join(here, 'workflow-b.json');
  const before = existsSync(privatePath) ? readFileSync(privatePath) : null;
  for (const args of [['--credential-free'], [privatePath, '--credential-free'], ['--unknown'],
    ['one.json', 'two.json']]) {
    const result = spawnSync(process.execPath, [join(here, 'build-workflow-b.mjs'), ...args],
      { encoding: 'utf8', env: credentialEnv, timeout: 10000 });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Usage:/);
  }
  if (before) assert.deepEqual(readFileSync(privatePath), before);
  else assert.equal(existsSync(privatePath), false);
});
