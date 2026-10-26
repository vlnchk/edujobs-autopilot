import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";


const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const read = (path) => readFileSync(join(root, path), "utf8");
const TEST_CREDENTIAL_ENVIRONMENT = Object.freeze({
  N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID: "sandbox-google-credential-id",
  N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_NAME: "Sandbox Google Service Account",
  N8N_OPENAI_CREDENTIAL_ID: "sandbox-openai-credential-id",
  N8N_OPENAI_CREDENTIAL_NAME: "Sandbox OpenAI API",
});
const generatedWorkflowDirectory = mkdtempSync(join(tmpdir(), "edujobs-sandbox-workflow-"));
const generatedWorkflowPath = join(generatedWorkflowDirectory, "workflow-a.json");
const generation = spawnSync(process.execPath, [join(root, "n8n/build-workflow.mjs"), generatedWorkflowPath], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, ...TEST_CREDENTIAL_ENVIRONMENT },
});
assert.equal(generation.status, 0, `${generation.stdout}\n${generation.stderr}`);
const workflow = JSON.parse(readFileSync(generatedWorkflowPath, "utf8"));

after(() => rmSync(generatedWorkflowDirectory, { recursive: true, force: true }));

function parseEnv(text) {
  return Object.fromEntries(text
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      assert.ok(separator > 0, `invalid .env.example line: ${line}`);
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
}

test("Compose resolves to exactly the three-service local sandbox", () => {
  const result = spawnSync(
    "docker",
    ["compose", "--env-file", ".env.example", "config", "--format", "json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const compose = JSON.parse(result.stdout);

  assert.deepEqual(Object.keys(compose.services).sort(), ["browserless", "content-worker", "n8n"]);
  assert.deepEqual(Object.keys(compose.volumes), ["n8n_data"]);
  assert.equal(compose.services.n8n.image, "docker.n8n.io/n8nio/n8n:2.35.7");
  assert.match(compose.services.browserless.image, /^ghcr\.io\/browserless\/chromium:v\d+\.\d+\.\d+$/);
  assert.equal(compose.services["content-worker"].build.context, join(root, "worker"));
  assert.equal(compose.services["content-worker"].read_only, true);

  const published = Object.entries(compose.services).flatMap(([service, definition]) =>
    (definition.ports ?? []).map((port) => ({ service, ...port })));
  assert.deepEqual(published, [{
    service: "n8n",
    mode: "ingress",
    host_ip: "127.0.0.1",
    target: 5678,
    published: "5678",
    protocol: "tcp",
  }]);

  for (const service of Object.values(compose.services)) {
    assert.deepEqual(Object.keys(service.networks), ["workflow-a-internal"]);
    assert.ok(service.healthcheck, "every local service must have a healthcheck");
  }
  assert.equal(compose.services.n8n.environment.N8N_BLOCK_ENV_ACCESS_IN_NODE, "false");
  assert.equal(compose.services.n8n.volumes.some((volume) =>
    volume.target === "/home/node/.n8n" && volume.type === "volume"), true);
  assert.equal(compose.services.n8n.environment.DB_TYPE, undefined, "n8n must use built-in SQLite");

  const serialized = JSON.stringify(compose).toLowerCase();
  for (const forbidden of ["postgres", "redis", "celery", "kafka", "telegram", "workflow b"]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden));
  }
});

test("environment example contains only non-secret sandbox configuration", () => {
  const values = parseEnv(read(".env.example"));
  const required = [
    "WORKFLOW_A_TEST_ROW_NUMBER",
    "GOOGLE_SHEETS_DOCUMENT_ID",
    "GOOGLE_SHEETS_SHEET_NAME",
    "N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID",
    "N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_NAME",
    "N8N_OPENAI_CREDENTIAL_ID",
    "N8N_OPENAI_CREDENTIAL_NAME",
    "CONTENT_WORKER_URL",
    "BROWSERLESS_URL",
    "ELIGIBILITY_MODEL",
    "EDITOR_MODEL",
    "VALIDATOR_MODEL",
    "VALIDATOR_REASONING_EFFORT",
    "WORKFLOW_VERSION",
    "CONFIG_VERSION",
    "FETCH_TIMEOUT_SECONDS",
    "MAX_REDIRECTS",
    "MAX_DOWNLOAD_BYTES",
    "MAX_EXTRACTED_CHARS",
    "MAX_LLM_SOURCE_CHARS",
    "MAX_PUBLICATION_DESCRIPTION_CHARS",
  ];
  assert.deepEqual(Object.keys(values).sort(), required.sort());
  assert.equal(values.CONTENT_WORKER_URL, "http://content-worker:8000");
  assert.equal(values.BROWSERLESS_URL, "http://browserless:3000/content");
  assert.ok(Number(values.MAX_LLM_SOURCE_CHARS) < Number(values.MAX_EXTRACTED_CHARS));
  assert.equal(values.MAX_PUBLICATION_DESCRIPTION_CHARS, "900");
  // Optional; empty uses the provider default.
  assert.equal(values.VALIDATOR_REASONING_EFFORT, "");
  for (const name of [
    "WORKFLOW_A_TEST_ROW_NUMBER", "GOOGLE_SHEETS_DOCUMENT_ID", "GOOGLE_SHEETS_SHEET_NAME",
    "N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID", "N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_NAME",
    "N8N_OPENAI_CREDENTIAL_ID", "N8N_OPENAI_CREDENTIAL_NAME",
    "ELIGIBILITY_MODEL", "EDITOR_MODEL", "VALIDATOR_MODEL", "CONFIG_VERSION",
  ]) assert.match(values[name], /^REPLACE_WITH_/);
  assert.deepEqual(
    Object.keys(values).filter((name) => /(?:KEY|TOKEN|PASSWORD|SECRET)/i.test(name)),
    [],
  );
  assert.doesNotMatch(read(".env.example"), /sk-[A-Za-z0-9_-]{12,}|BEGIN (?:RSA )?PRIVATE KEY/);
});

test("worker image is minimal, non-root, stateless, and health-checkable", () => {
  const dockerfile = read("worker/Dockerfile");
  assert.match(dockerfile, /^FROM python:3\.12\.13-slim-bookworm/m);
  assert.match(dockerfile, /^USER worker$/m);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*\/health/);
  assert.match(dockerfile, /uvicorn[\s\S]*app\.main:app/);
  assert.doesNotMatch(dockerfile, /EXPOSE|postgres|redis|celery|supervisor/i);
  assert.match(read("worker/.dockerignore"), /^tests\/$/m);
});

test("M7 workflow keeps strict contracts, injected credential references, and one selected-row update", () => {
  assert.equal(workflow.active, false);
  assert.equal(workflow.name, "EduJobs v2 · Vacancy Intake");
  const nodes = new Map(workflow.nodes.map((node) => [node.name, node]));
  for (const name of [
    "Manual Trigger",
    "Workflow Configuration",
    "Read Sheet Rows For Selection And Duplicates",
    "Plan Source Acquisition",
    "Extract Original Link",
    "Extract Project Link",
    "Eligibility Decision",
    "MINIMAL Editor",
    "ENRICH Editor",
    "MINIMAL Validator",
    "ENRICH Validator",
    "Execute Deterministic KEEP",
    "Start MINIMAL Fallback",
    "Start KEEP Fallback",
    "Prepare Terminal Persistence",
    "Persist Terminal State",
    "Runner Verification Required",
    "Read Sheet Rows After Runner Execution",
    "Build Runner Result",
  ]) assert.ok(nodes.has(name), `missing required node: ${name}`);

  for (const [source, connection] of Object.entries(workflow.connections)) {
    assert.ok(nodes.has(source), `connection source is missing: ${source}`);
    for (const output of connection.main) {
      for (const target of output) assert.ok(nodes.has(target.node), `connection target is missing: ${target.node}`);
    }
  }

  const configuration = nodes.get("Workflow Configuration").parameters.assignments.assignments;
  const assignment = (name) => configuration.find((item) => item.name === name)?.value;
  for (const name of [
    "ELIGIBILITY_MODEL", "EDITOR_MODEL", "VALIDATOR_MODEL",
    "WORKFLOW_VERSION", "CONFIG_VERSION",
  ]) assert.equal(assignment(name.toLowerCase()), `={{ $env.${name} }}`);
  assert.equal(assignment("validator_reasoning_effort"), "={{ $env.VALIDATOR_REASONING_EFFORT || '' }}");
  assert.equal(assignment("source_requirement_model"), undefined);
  assert.equal(assignment("selected_row_number"), "={{ Number('row_number' in $json ? $json.row_number : ($env.WORKFLOW_A_RUNNER_ROW_NUMBER || $env.WORKFLOW_A_TEST_ROW_NUMBER)) }}");
  assert.equal(assignment("runner_mode"), "={{ Boolean($env.WORKFLOW_A_RUNNER_ROW_NUMBER) }}");
  assert.equal(assignment("execution_id"), "={{ String($execution.id || '') }}");

  const openAiNodes = workflow.nodes.filter((node) =>
    node.type === "n8n-nodes-base.httpRequest" && node.parameters.url === "https://api.openai.com/v1/responses");
  assert.ok(openAiNodes.length > 0);
  for (const node of openAiNodes) {
    assert.match(node.parameters.jsonBody, /json_schema/);
    assert.match(node.parameters.jsonBody, /strict: true/);
    assert.deepEqual(node.credentials.openAiApi, {
      id: TEST_CREDENTIAL_ENVIRONMENT.N8N_OPENAI_CREDENTIAL_ID,
      name: TEST_CREDENTIAL_ENVIRONMENT.N8N_OPENAI_CREDENTIAL_NAME,
    });
  }

  const sheetNodes = workflow.nodes.filter((node) => node.type === "n8n-nodes-base.googleSheets");
  assert.equal(sheetNodes.length, 3);
  for (const node of sheetNodes) {
    assert.equal(node.parameters.authentication, "serviceAccount");
    assert.deepEqual(node.credentials.googleApi, {
      id: TEST_CREDENTIAL_ENVIRONMENT.N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID,
      name: TEST_CREDENTIAL_ENVIRONMENT.N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_NAME,
    });
  }
  const updates = sheetNodes.filter((node) => node.parameters.operation === "update");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].parameters.columns.matchingColumns, ["row_number"]);
  for (const raw of ["Timestamp", "Short Description", "Project Website Link", "Original Link", "Contact Info"]) {
    assert.equal(raw in updates[0].parameters.columns.value, false);
  }
  assert.equal(workflow.connections["Persist Terminal State"].main[0][0].node, "Runner Verification Required");
  assert.equal(workflow.connections["Runner Verification Required"].main[0][0].node, "Read Sheet Rows After Runner Execution");

  const serialized = JSON.stringify(workflow);
  assert.doesNotMatch(serialized, /REPLACE_WITH_/);
  assert.doesNotMatch(serialized, /sk-[A-Za-z0-9_-]{12,}|BEGIN (?:RSA )?PRIVATE KEY/);
  assert.doesNotMatch(serialized, /docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]{20,}/);
});

test("runbook covers the complete user-operated M7 path without embedded secrets", () => {
  const readme = read("docs/LOCAL_SANDBOX.md");
  for (const required of [
    "docker compose config --quiet",
    "docker compose build content-worker",
    "http://127.0.0.1:5678",
    "import:workflow --input=/files/n8n/workflow-a.json",
    "OpenAI",
    "Google Service Account API",
    "application_id",
    "source_requirement_json",
    "validation_history_json",
    "WORKFLOW_A_TEST_ROW_NUMBER",
    "READY_FOR_PUBLISH",
    "REJECTED",
    "NEEDS_REVIEW",
    "ERROR",
    "re-run",
    "Troubleshooting",
    "docker compose down",
  ]) assert.match(readme, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  assert.match(readme, /exactly one/i);
  assert.match(readme, /raw fields are unchanged/i);
  assert.match(readme, /non-production/i);
  assert.doesNotMatch(readme, /sk-[A-Za-z0-9_-]{12,}|BEGIN (?:RSA )?PRIVATE KEY/);
});
