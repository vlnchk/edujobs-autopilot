import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyRequestContexts } from "./verify-request-context.mjs";


const inputPath = process.argv[2];
assert.ok(inputPath, "usage: node verify-runtime.mjs WORKFLOW_JSON");
const parsed = JSON.parse(readFileSync(inputPath, "utf8"));
const workflow = Array.isArray(parsed) ? parsed[0] : parsed;
assert.ok(workflow && (!Array.isArray(parsed) || parsed.length === 1), "expected exactly one workflow");

const version = execFileSync("n8n", ["--version"], { encoding: "utf8" }).trim();
assert.equal(version, "2.35.7", "runtime verification must use the canonical n8n target");

const nodes = new Map(workflow.nodes.map((node) => [node.name, node]));
const requiredNodes = [
  "Manual Trigger",
  "When Executed by Another Workflow",
  "Workflow Configuration",
  "Generate Application UUID",
  "Read Sheet Rows For Selection And Duplicates",
  "Prepare Selected Application",
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
  "Prepare Reviewer Draft",
  "Reviewer Draft Required",
  "ENRICH Draft Complete",
  "Prepare Terminal Persistence",
  "Persist Terminal State",
  "Runner Verification Required",
  "Read Sheet Rows After Runner Execution",
  "Build Runner Result",
];
for (const name of requiredNodes) assert.ok(nodes.has(name), `missing required node after import: ${name}`);
assert.equal(workflow.active, false, "imported workflow must remain inactive");

for (const [source, connection] of Object.entries(workflow.connections)) {
  assert.ok(nodes.has(source), `missing connection source: ${source}`);
  for (const output of connection.main) {
    for (const target of output) assert.ok(nodes.has(target.node), `missing connection target: ${target.node}`);
  }
}
for (const [from, to] of [
  ["Manual Trigger", "Workflow Configuration"],
  ["When Executed by Another Workflow", "Workflow Configuration"],
  ["Workflow Configuration", "Generate Application UUID"],
  ["M4 Source Acquisition Complete", "Eligibility Decision"],
  ["M5 Accepted KEEP", "Initialize KEEP Editorial"],
  ["M5 Accepted MINIMAL", "Initialize MINIMAL Editorial"],
  ["M5 Accepted ENRICH", "Initialize ENRICH Editorial"],
  ["M5 Rejected", "Prepare Reviewer Draft"],
  ["M5 Needs Review", "Prepare Reviewer Draft"],
  ["Prepare Reviewer Draft", "Reviewer Draft Required"],
  ["Reviewer Draft Required", "Begin ENRICH Attempt"],
  ["ENRICH Draft Complete", "Prepare Terminal Persistence"],
  ["Prepare Terminal Persistence", "Persist Terminal State"],
  ["Persist Terminal State", "Runner Verification Required"],
  ["Runner Verification Required", "Read Sheet Rows After Runner Execution"],
  ["Read Sheet Rows After Runner Execution", "Build Runner Result"],
]) {
  const targets = (workflow.connections[from]?.main ?? []).flat().map((target) => target.node);
  assert.ok(targets.includes(to), `missing required connection after import: ${from} -> ${to}`);
}

const sheetNodes = workflow.nodes.filter((node) => node.type === "n8n-nodes-base.googleSheets");
assert.equal(sheetNodes.length, 3);
for (const node of sheetNodes) {
  assert.equal(node.parameters.authentication, "serviceAccount");
  assert.equal(typeof node.credentials.googleApi.id, "string");
  assert.ok(node.credentials.googleApi.id.length > 0);
  assert.equal(typeof node.credentials.googleApi.name, "string");
  assert.ok(node.credentials.googleApi.name.length > 0);
  assert.match(node.parameters.documentId.value, /GOOGLE_SHEETS_DOCUMENT_ID/);
  assert.match(node.parameters.sheetName.value, /GOOGLE_SHEETS_SHEET_NAME/);
}
const updates = sheetNodes.filter((node) => node.parameters.operation === "update");
assert.equal(updates.length, 1);
assert.deepEqual(updates[0].parameters.columns.matchingColumns, ["row_number"]);
assert.equal(updates[0].parameters.columns.value.draft_description, "={{ $json.draft_description }}");
assert.equal(updates[0].parameters.columns.value.final_description, "={{ $json.final_description }}");
for (const field of ["role_title", "employer_name", "project_link_text"]) {
  assert.equal(updates[0].parameters.columns.value[field], `={{ $json.${field} }}`);
}
for (const raw of ["Timestamp", "Short Description", "Project Website Link", "Original Link", "Contact Info"]) {
  assert.equal(raw in updates[0].parameters.columns.value, false);
}

const openAiNodes = workflow.nodes.filter((node) =>
  node.type === "n8n-nodes-base.httpRequest" && node.parameters.url === "https://api.openai.com/v1/responses");
assert.ok(openAiNodes.length > 0);
for (const node of openAiNodes) {
  assert.equal(typeof node.credentials.openAiApi.id, "string");
  assert.ok(node.credentials.openAiApi.id.length > 0);
  assert.equal(typeof node.credentials.openAiApi.name, "string");
  assert.ok(node.credentials.openAiApi.name.length > 0);
  assert.match(node.parameters.jsonBody, /json_schema/);
  assert.match(node.parameters.jsonBody, /strict: true/);
}

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const require = createRequire(import.meta.url);
const { Workflow } = require(join(globalRoot, "n8n/node_modules/n8n-workflow"));
const requestContextEvaluations = verifyRequestContexts(workflow, Workflow);
const { extendSyntax } = require(join(
  globalRoot,
  "n8n/node_modules/n8n-workflow/dist/cjs/extensions/expression-extension.js",
));
const expressions = workflow.nodes
  .map((node) => ({ name: node.name, body: node.parameters.jsonBody ?? node.parameters.body }))
  .filter(({ body }) => typeof body === "string" && body.startsWith("={{"));
assert.ok(expressions.length > 0);
for (const { name, body } of expressions) {
  assert.doesNotThrow(() => extendSyntax(body), `${name} has invalid n8n 2.35.7 expression syntax`);
}

const configuration = nodes.get("Workflow Configuration").parameters.assignments.assignments;
const value = (name) => configuration.find((item) => item.name === name)?.value;
assert.equal(value("selected_row_number"), "={{ Number('row_number' in $json ? $json.row_number : ($env.WORKFLOW_A_RUNNER_ROW_NUMBER || $env.WORKFLOW_A_TEST_ROW_NUMBER)) }}");
assert.equal(value("runner_mode"), "={{ Boolean($env.WORKFLOW_A_RUNNER_ROW_NUMBER) }}");
assert.equal(value("execution_id"), "={{ String($execution.id || '') }}");
assert.equal(value("workflow_version"), "={{ $env.WORKFLOW_VERSION }}");
assert.equal(value("config_version"), "={{ $env.CONFIG_VERSION }}");
assert.doesNotMatch(JSON.stringify(workflow), /PUBLICATION_BODY_|publication_body_(?:target_)?(?:min_|max_)?chars/);
assert.doesNotMatch(JSON.stringify(workflow), /REPLACE_WITH_/);

process.stdout.write(JSON.stringify({
  n8n_version: version,
  workflow: workflow.name,
  nodes: workflow.nodes.length,
  expression_bodies: expressions.length,
  request_context_evaluations: requestContextEvaluations,
  inactive: workflow.active === false,
  single_row_update: true,
}) + "\n");
