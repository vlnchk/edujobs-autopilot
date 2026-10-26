import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { concisionPairs, concisionContext, concisionFact } from "./concision-fixtures.mjs";

import { prepareApplication } from "../workflow-logic/deterministic.mjs";
import { extractCanonicalUrls } from "../workflow-logic/url-text.mjs";
import { insertProjectLink } from "../workflow-logic/project-link.mjs";
import { sanitizePublicationText } from "../workflow-logic/publication-text.mjs";
import { visibleLength } from "../workflow-logic/publication-shape.mjs";
import { verifyCompletenessGrouping } from "./investigate-completeness.mjs";
import { mergedCandidate, splitCandidate, vacancyContext, completeReference, noisyContexts, fallbackFacets, fallbackAnnouncement, fallbackReference, fallbackSummary } from "./completeness-fixtures.mjs";
import { verifySourceNoiseOverride, noisyEmployerContext, sparseTitle } from "./investigate-source-noise.mjs";
import { gapSubmission, gapMention, gapProjectUrl, gapSourceLayouts, gapElements, gapMinimalCandidate, gapEnrichCandidate, gapEnrichFacts, sufficientSubmission, sufficientConcise } from "./material-gap-fixtures.mjs";


const here = dirname(fileURLToPath(import.meta.url));
const generatedWorkflowDirectory = mkdtempSync(join(tmpdir(), "edujobs-workflow-a-build-"));
const workflowPath = join(generatedWorkflowDirectory, "workflow-a.json");
const TEST_CREDENTIAL_ENVIRONMENT = Object.freeze({
  N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID: "test-google-credential-id",
  N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_NAME: "Test Google Service Account",
  N8N_OPENAI_CREDENTIAL_ID: "test-openai-credential-id",
  N8N_OPENAI_CREDENTIAL_NAME: "Test OpenAI API",
});
const generation = spawnSync(process.execPath, [join(here, "build-workflow.mjs"), workflowPath], {
  cwd: here,
  encoding: "utf8",
  env: { ...process.env, ...TEST_CREDENTIAL_ENVIRONMENT },
});
assert.equal(generation.status, 0, `${generation.stdout}\n${generation.stderr}`);
const workflow = JSON.parse(readFileSync(workflowPath, "utf8"));
const nodes = new Map(workflow.nodes.map((node) => [node.name, node]));

after(() => rmSync(generatedWorkflowDirectory, { recursive: true, force: true }));

test("workflow generation fails clearly when credential environment variables are missing", () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "edujobs-workflow-a-missing-credentials-"));
  try {
    const environment = { ...process.env };
    for (const name of Object.keys(TEST_CREDENTIAL_ENVIRONMENT)) delete environment[name];
    const result = spawnSync(
      process.execPath,
      [join(here, "build-workflow.mjs"), join(outputDirectory, "workflow-a.json")],
      { cwd: here, encoding: "utf8", env: environment },
    );
    assert.notEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /Missing required n8n credential environment variables/);
    for (const name of Object.keys(TEST_CREDENTIAL_ENVIRONMENT)) assert.match(output, new RegExp(name));
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("workflow generation rejects a remaining REPLACE_WITH_ credential placeholder", () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "edujobs-workflow-a-placeholder-"));
  try {
    const result = spawnSync(
      process.execPath,
      [join(here, "build-workflow.mjs"), join(outputDirectory, "workflow-a.json")],
      {
        cwd: here,
        encoding: "utf8",
        env: {
          ...process.env,
          ...TEST_CREDENTIAL_ENVIRONMENT,
          N8N_OPENAI_CREDENTIAL_ID: "REPLACE_WITH_N8N_OPENAI_CREDENTIAL_ID",
        },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /forbidden REPLACE_WITH_ placeholder/);
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

const CONFIG = Object.freeze({
  selected_row_number: 2,
  runner_mode: false,
  execution_id: "fixture-execution-1",
  content_worker_url: "http://content-worker:8000",
  source_requirement_model: "mock-source-model",
  eligibility_model: "mock-eligibility-model",
  editor_model: "mock-editor-model",
  validator_model: "mock-validator-model",
  max_llm_source_chars: 100,
  max_extracted_chars: 1000,
  max_publication_description_chars: 900,
  workflow_version: "workflow-a-v2.3.1-m7",
  config_version: "fixture-v1",
});

// Section 13.0.1: editors see the maximum, the 85% target and the submission's visible length.
const editorMetadata = (short) => ({
  max_visible_chars: CONFIG.max_publication_description_chars,
  target_visible_chars: Math.floor(CONFIG.max_publication_description_chars * 0.85),
  short_description_visible_chars: visibleLength(sanitizePublicationText(short)),
});

const linked = (text, selection = "Teach", url = VALID_ROW["Project Website Link"]) =>
  insertProjectLink(sanitizePublicationText(text), selection, url).text;

const GENERATED_APPLICATION_ID = "00000000-0000-4000-8000-000000000001";

const EXPECTED_REJECTION_REASONS = [
  "NO_PROJECT_LINK",
  "PROJECT_NOT_CONFIRMED",
  "LINK_BROKEN",
  "WRONG_LINK_TARGET",
  "SOCIAL_LINK_ONLY",
  "NO_VALID_CONTACT",
  "TELEGRAM_BOT_CONTACT",
  "PRIVATE_TUTOR_REQUEST",
  "SUSPICIOUS_INFOBUSINESS",
  "SALES",
  "OUT_OF_SCOPE",
  "UNETHICAL_SERVICE",
  "NON_CORE_ADMIN_OPS",
  "NOT_A_VACANCY",
  "DUPLICATE_APPLICATION",
];

const EXPECTED_EVIDENCE_SOURCES = [
  "short_description",
  "original_link",
  "project_link",
  "contact_info",
  "existing_application",
];

// Mirrors JsTaskRunner.getNativeVariables() in n8n 2.37.10's bundled
// @n8n/task-runner 2.37.5. VM intrinsics are supplied by node:vm itself.
const N8N_2_37_10_NATIVE_GLOBALS = Object.freeze({
  Buffer,
  setTimeout,
  setInterval,
  setImmediate,
  clearTimeout,
  clearInterval,
  clearImmediate,
  btoa,
  atob,
  TextDecoder,
  TextDecoderStream,
  TextEncoder,
  TextEncoderStream,
  FormData,
});

const VALID_ROW = Object.freeze({
  row_number: 2,
  Timestamp: "2026-09-04 10:00",
  "Short Description": "Teach adults.",
  "Project Website Link": "https://example.com/project",
  "Original Link": "https://example.com/jobs/1",
  "Contact Info": "jobs@example.com",
});

const ACCEPT_KEEP = Object.freeze({
  project_link_text: "Teach", role_title: null, employer_name: null, decision: "ACCEPT",
  primary_reason: null,
  reasons: [],
  evidence: [],
  review_reason: null,
  editorial_mode: "KEEP",
  editorial_reason: "The normalized Short Description is already publishable.", material_gaps: [],
});

const REVIEW_DECISION = Object.freeze({
  project_link_text: "Teach", role_title: null, employer_name: null, decision: "NEEDS_REVIEW", primary_reason: null, reasons: [], evidence: [],
  review_reason: "Employer identity needs human confirmation.", editorial_mode: null, editorial_reason: null, material_gaps: [],
});
const SALES_DECISION = Object.freeze({
  project_link_text: "Teach", role_title: null, employer_name: null, decision: "REJECT", primary_reason: "SALES", reasons: ["SALES"],
  evidence: [{ reason: "SALES", source: "short_description", text: "Sell courses to adult learners." }],
  review_reason: null, editorial_mode: null, editorial_reason: null, material_gaps: [],
});

function responseWithText(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return {
    output: [{
      type: "message",
      content: [{ type: "output_text", text }],
    }],
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function executeCode(name, inputJson, namedOutputs = {}, config = CONFIG) {
  const code = nodes.get(name)?.parameters?.jsCode;
  assert.equal(typeof code, "string", `Missing Code node: ${name}`);
  const input = Array.isArray(inputJson) ? inputJson : [inputJson];
  const sandbox = {
    ...N8N_2_37_10_NATIVE_GLOBALS,
    $input: {
      all: () => input.map((json) => ({ json })),
      first: () => ({ json: input[0] }),
    },
    $: (nodeName) => ({
      first: () => {
        if (nodeName === "Workflow Configuration") return { json: config };
        if (nodeName === "Generate Application UUID") {
          return { json: { ...config, generated_application_id: GENERATED_APPLICATION_ID } };
        }
        if (!(nodeName in namedOutputs)) {
          throw new Error(`Fixture did not provide output for ${nodeName}`);
        }
        return { json: namedOutputs[nodeName] };
      },
      all: () => {
        if (!(nodeName in namedOutputs)) {
          throw new Error(`Fixture did not provide output for ${nodeName}`);
        }
        const output = namedOutputs[nodeName];
        return (Array.isArray(output) ? output : [output]).map((json) => ({ json }));
      },
    }),
  };
  const script = new vm.Script(`(async () => {\n${code}\n})()`);
  const result = await script.runInNewContext(sandbox);
  return result[0].json;
}

function evaluateJsonBody(name, namedOutputs = {}, config = CONFIG) {
  const body = nodes.get(name)?.parameters?.jsonBody;
  assert.equal(typeof body, "string", `Missing JSON body expression: ${name}`);
  assert.ok(body.startsWith("={{") && body.endsWith("}}"), `${name} must use an n8n expression`);
  const expression = body.slice(3, -2).trim();
  const sandbox = {
    ...N8N_2_37_10_NATIVE_GLOBALS,
    $: (nodeName) => ({
      first: () => {
        if (nodeName === "Workflow Configuration") return { json: config };
        if (!(nodeName in namedOutputs)) throw new Error(`Fixture did not provide output for ${nodeName}`);
        return { json: namedOutputs[nodeName] };
      },
    }),
  };
  return JSON.parse(new vm.Script(expression).runInNewContext(sandbox));
}

function workerSuccess(text, overrides = {}) {
  return {
    status: "success",
    source_type: "html",
    title: "Vacancy",
    text,
    links: [],
    extraction_method: "http",
    warnings: [],
    ...overrides,
  };
}

function workerFailure(errorCode, overrides = {}) {
  return {
    status: "extraction_failed",
    source_type: "html",
    error_code: errorCode,
    error_message: `fixture ${errorCode}`,
    warnings: [],
    ...overrides,
  };
}

async function runFixture(fixture) {
  const rows = fixture.rows ?? [{ ...VALID_ROW, ...(fixture.row ?? {}) }];
  const counters = {
    worker_calls: [],
    context_selector_calls: [],
    context_inputs: [],
    eligibility_calls: 0,
    eligibility_inputs: [],
  };
  const prepared = await executeCode(
    "Prepare Selected Application",
    rows,
    {},
    { ...CONFIG, ...(fixture.config ?? {}) },
  );
  if (prepared.processing_status !== "PROCESSING") {
    return { state: prepared, counters };
  }

  let state = await executeCode("Plan Source Acquisition", prepared);
  // Fixtures name the links whose default worker response is readable; other
  // links default to a technical failure so ordinary fixtures keep submission-only inputs.
  const readable = new Set(fixture.readable_sources ?? []);

  for (const source of ["original_link", "project_link"]) {
    // Mirrors the Fetch IF nodes: both valid, non-social links are fetched.
    if (!state.m4.fetch[source]) continue;
    counters.worker_calls.push(source);
    const workerResponse = fixture.worker_responses?.[source]
      ?? (readable.has(source) ? workerSuccess(`${source} ordinary content`) : workerFailure("FETCH_FAILED"));
    const applyNode = source === "original_link"
      ? "Apply Original Worker Result"
      : "Apply Project Worker Result";
    const stateNode = source === "original_link"
      ? "Plan Source Acquisition"
      : "Original Source Ready";
    state = await executeCode(
      applyNode,
      workerResponse,
      { [stateNode]: state },
    );
    if (state.processing_status !== "PROCESSING") break;

    const target = state.sources[source];
    if (target.context_selection_required) {
      counters.context_selector_calls.push(source);
      counters.context_inputs.push(target.full_text_for_selection);
      const contextResponses = fixture.context_responses?.[source] ?? [{
        selected_context: `${source} selected context`,
        relation: "RELEVANT",
        reason: null,
      }];
      const validationNode = source === "original_link"
        ? "Validate Original Context"
        : "Validate Project Context";
      const firstContext = await executeCode(validationNode, responseWithText(contextResponses[0]));
      let contextEnvelope = firstContext;
      if (!firstContext.contract_valid) {
        counters.context_selector_calls.push(source);
        const retryNode = source === "original_link"
          ? "Validate Original Context Retry"
          : "Validate Project Context Retry";
        contextEnvelope = await executeCode(
          retryNode,
          responseWithText(contextResponses[1] ?? contextResponses[0]),
          { [validationNode]: firstContext },
        );
        if (!contextEnvelope.contract_valid) {
          const contractErrorNode = source === "original_link"
            ? "Original Context Contract Error"
            : "Project Context Contract Error";
          state = await executeCode(
            contractErrorNode,
            contextEnvelope,
            { [applyNode]: state },
          );
          break;
        }
      }
      const applyContextNode = source === "original_link"
        ? "Apply Original Context"
        : "Apply Project Context";
      state = await executeCode(
        applyContextNode,
        contextEnvelope,
        { [applyNode]: state },
      );
    }

    if (source === "original_link") {
      // Mirrors the Original Source Ready pass-through before the project branch.
      state = JSON.parse(JSON.stringify(state));
    }
  }

  if (state.processing_status === "PROCESSING") {
    state = await executeCode("M4 Source Acquisition Complete", state);
  }
  if (state.processing_status !== "PROCESSING" || fixture.stop_before_eligibility) {
    return { state, counters };
  }

  const eligibilityResponses = fixture.eligibility_responses ?? [ACCEPT_KEEP];
  counters.eligibility_calls += 1;
  counters.eligibility_inputs.push(evaluateJsonBody(
    "Eligibility Decision",
    { "M4 Source Acquisition Complete": state },
  ));
  const firstEligibility = await executeCode(
    "Validate Eligibility Decision",
    responseWithText(eligibilityResponses[0]),
    { "M4 Source Acquisition Complete": state },
  );
  let eligibilityEnvelope = firstEligibility;
  if (!firstEligibility.contract_valid) {
    counters.eligibility_calls += 1;
    counters.eligibility_inputs.push(evaluateJsonBody(
      "Eligibility Contract Retry",
      {
        "M4 Source Acquisition Complete": state,
        "Validate Eligibility Decision": firstEligibility,
      },
    ));
    eligibilityEnvelope = await executeCode(
      "Validate Eligibility Decision Retry",
      responseWithText(eligibilityResponses[1] ?? eligibilityResponses[0]),
      { "Validate Eligibility Decision": firstEligibility },
    );
    if (!eligibilityEnvelope.contract_valid) {
      state = await executeCode("Eligibility Contract Error", eligibilityEnvelope);
      return { state, counters };
    }
  }

  state = await executeCode("Apply Eligibility Decision", eligibilityEnvelope);
  const routeNode = state.eligibility_decision === "REJECT"
    ? "M5 Rejected"
    : state.eligibility_decision === "NEEDS_REVIEW"
      ? "M5 Needs Review"
      : `M5 Accepted ${state.editorial_mode}`;
  state = await executeCode(routeNode, state);
  return { state, counters };
}

const VALIDATION_PASS = Object.freeze({ decision: "PASS", issues: [] });
const VALIDATOR_ISSUES = [
  "UNSUPPORTED_FACT",
  "CONTRADICTION",
  "MEANING_LOST",
  "FORBIDDEN_SOURCE_USAGE",
  "INVENTED_NUMBER_OR_DATE",
  "EXCESSIVE_REWRITE",
  "OTHER_CONTRACT_VIOLATION",
];

test("both generated output checks embed the single canonical editorial URL helper", () => {
  for (const mode of ["MINIMAL", "ENRICH"]) {
    assert.ok(nodes.get(`Deterministic ${mode} Output Check`).parameters.jsCode.includes(extractCanonicalUrls.toString()));
  }
});

test("all link boundaries embed the same canonical helper without changing workflow topology", () => {
  for (const name of ["Deterministic MINIMAL Output Check", "Deterministic ENRICH Output Check", "Execute Deterministic KEEP", "Validate Deterministic KEEP", "Prepare Terminal Persistence"]) {
    assert.ok(nodes.get(name).parameters.jsCode.includes(insertProjectLink.toString()), name);
  }
  assert.equal(workflow.nodes.length, 120);
});

test("MINIMAL accepts equivalent source URL presentations and rejects new canonical URLs", async () => {
  const url = "https://example.com/foo?tab=t.0#details";
  for (const presentation of [url, `(${url})текст`, `[описание](${url})`, `${url}, следующий текст`]) {
    const draft = `Teach adults. Details: [описание](${url}).`;
    const result = await runM6Fixture({
      row: { "Short Description": `Teach adults. Details: ${presentation}` },
      eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: "MINIMAL" }],
      editor_responses: { MINIMAL: [{ project_link_text: "Teach", draft_description: draft, facts_added: [] }] },
    });
    assert.equal(result.update.final_description, linked(draft), presentation);
    assert.deepEqual(plain(result.state.validation_history), [{ attempt: 1, mode: "MINIMAL", decision: "PASS", issues: [] }]);
  }
  for (const unsupported of ["https://evil.example/new", url.replace("t.0", "t.1"), url.replace("details", "other")]) {
    const result = await runM6Fixture({
      row: { "Short Description": `Teach adults. Details: (${url})текст` },
      eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: "MINIMAL" }],
      editor_responses: { MINIMAL: [{ project_link_text: "Teach", draft_description: `Teach adults. Details: ${unsupported}`, facts_added: [] }] },
    });
    assert.deepEqual(plain(result.state.validation_history[0].issues), ["FORBIDDEN_SOURCE_USAGE"]);
    assert.equal(result.state.final_editorial_mode, "KEEP");
  }
});

test("ENRICH canonicalizes URLs from approved external context with valid nested parentheses", async () => {
  const url = "https://example.com/foo_(bar(baz))?tab=t.0#details";
  const evidence = `The schedule is 20 hours per week. Details: (${url})короткое тестовое задание`;
  const draft = `Teach adults. The schedule is 20 hours per week. Details: [описание](${url}).`;
  const result = await runM6Fixture({
    config: { max_llm_source_chars: 500 },
    readable_sources: ["original_link"],
    worker_responses: { original_link: workerSuccess(evidence) },
    eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: "ENRICH" }],
    editor_responses: { ENRICH: [{ project_link_text: "Teach", draft_description: draft,
      facts_added: [{ fact: "20 hours per week", source: "original_link", evidence: "20 hours per week" }] }] },
  });
  assert.equal(result.update.final_description, linked(draft));
  assert.equal(result.state.final_editorial_mode, "ENRICH");
  assert.equal(result.state.validation_history[0].decision, "PASS");
});

test("reported row-13 boundary shape: an unread Original Link reviewed by the combined decision still gets a reviewer draft", async () => {
  // Synthetic vacancy material: reproduces the reported execution shape without
  // accessing the saved execution or branching on a row/execution identifier.
  const url = "https://docs.google.com/document/d/example/edit?tab=t.0";
  const body = "Онлайн-школа ищет преподавателя английского языка. Обязанности: проводить занятия для взрослых и готовить учебные материалы. Требования: опыт преподавания и грамотная речь. Условия: удалённая работа и гибкий график.";
  const source = `${body}\n(${url})короткое тестовое задание`;
  const cleanDraft = `${body}\nКороткое тестовое задание: ${url}`;
  const fixture = {
    row: { "Short Description": source },
    worker_responses: { original_link: workerFailure("EXTRACTION_FAILED") },
    eligibility_responses: [{ ...REVIEW_DECISION, review_reason: "Не удалось прочитать страницу вакансии." }],
  };
  const passed = await runM6Fixture({ ...fixture,
    editor_responses: { ENRICH: [{ project_link_text: "Teach", draft_description: cleanDraft, facts_added: [] }] } });
  assert.equal(passed.update.processing_status, "NEEDS_REVIEW");
  assert.equal(passed.update.review_reason, "Не удалось прочитать страницу вакансии.");
  assert.equal(passed.state.sources.original_link.status, "extraction_failed");
  assert.equal(passed.update.draft_description, linked(cleanDraft));
  assert.equal(passed.update.final_description, "");
  assert.equal(passed.state.initial_editorial_mode, null);
  assert.equal(passed.state.final_editorial_mode, null);
  assert.deepEqual(plain(passed.state.validation_history), []);
  assert.deepEqual(plain(passed.state.m6.reviewer_validation), { decision: "PASS", issues: [] });
  assert.deepEqual(passed.counters.editor_calls, ["ENRICH"]);
  assert.deepEqual(passed.counters.validator_calls, ["ENRICH"]);
  assert.equal(passed.counters.persistence_updates, 1);

  const blocked = await runM6Fixture({ ...fixture,
    editor_responses: { ENRICH: [{ project_link_text: "Teach", draft_description: cleanDraft + " https://evil.example/new", facts_added: [] }] } });
  assert.equal(blocked.update.processing_status, "NEEDS_REVIEW");
  assert.equal(blocked.update.review_reason, passed.update.review_reason);
  // Section 15.1: a factually failed candidate falls back to the submission.
  assert.equal(blocked.update.draft_description, linked(source));
  assert.equal(blocked.update.final_description, "");
  assert.deepEqual(plain(blocked.state.m6.reviewer_validation), { decision: "FAIL", issues: ["FORBIDDEN_SOURCE_USAGE"] });
  assert.deepEqual(blocked.counters.editor_calls, ["ENRICH"]);
  assert.deepEqual(blocked.counters.validator_calls, []);
});

function defaultEditorResponse(mode, state) {
  if (mode === "MINIMAL") {
    return { project_link_text: state.submission_project_link_text ?? null, draft_description: state.normalized.short_description, facts_added: [] };
  }
  const source = ["original_link", "project_link"].find((name) => (
    (!state.m6?.draft_only || Object.hasOwn(state.m6.draft_context, name))
    && state.sources?.[name]?.status === "success"
    && state.sources[name].relation === "RELEVANT"
    && typeof state.sources[name].used_context === "string"
    && state.sources[name].used_context.trim().length > 0
  ));
  if (!source) return { project_link_text: state.submission_project_link_text ?? null, draft_description: state.normalized.short_description, facts_added: [] };
  const evidence = state.sources[source].used_context;
  return {
    project_link_text: state.submission_project_link_text ?? null, draft_description: `${state.normalized.short_description}\n\n${evidence}`,
    facts_added: [{ fact: evidence, source, evidence }],
  };
}

async function executeCreativeMode(mode, inputState, fixture, counters) {
  const beginNode = `Begin ${mode} Attempt`;
  const editorNode = `${mode} Editor`;
  const editorValidationNode = `Validate ${mode} EditedContent`;
  const editorRetryNode = `${mode} Editor Contract Retry`;
  const editorRetryValidationNode = `Validate ${mode} EditedContent Retry`;
  const deterministicNode = `Deterministic ${mode} Output Check`;
  const recordFailureNode = `Record ${mode} Deterministic Failure`;
  const validatorNode = `${mode} Validator`;
  const validatorValidationNode = `Validate ${mode} ValidationResult`;
  const validatorRetryNode = `${mode} Validator Contract Retry`;
  const validatorRetryValidationNode = `Validate ${mode} ValidationResult Retry`;

  const begin = await executeCode(beginNode, inputState);
  const editorResponses = (fixture.editor_responses?.[mode] ?? [defaultEditorResponse(mode, begin)])
    .map((response) => begin.m6?.draft_only && !begin.m5 && response && typeof response === "object"
      ? { role_title: null, employer_name: null, ...response } : response);
  counters.editor_calls.push(mode);
  counters.editor_inputs.push({
    mode,
    retry: false,
    body: evaluateJsonBody(editorNode, { [beginNode]: begin }),
  });
  let edited = await executeCode(
    editorValidationNode,
    responseWithText(editorResponses[0]),
    { [beginNode]: begin },
  );
  if (!edited.contract_valid) {
    counters.editor_calls.push(mode);
    counters.editor_inputs.push({
      mode,
      retry: true,
      body: evaluateJsonBody(editorRetryNode, {
        [beginNode]: begin,
        [editorValidationNode]: edited,
      }),
    });
    edited = await executeCode(
      editorRetryValidationNode,
      responseWithText(editorResponses[1] ?? editorResponses[0]),
      { [editorValidationNode]: edited },
    );
    if (!edited.contract_valid) {
      return executeCode(`${mode} Editor Contract Error`, edited);
    }
  }

  const checked = await executeCode(deterministicNode, edited);
  if (checked.deterministic_result.decision === "FAIL") {
    return executeCode(recordFailureNode, checked);
  }

  const validatorResponses = fixture.validator_responses?.[mode] ?? [VALIDATION_PASS];
  counters.validator_calls.push(mode);
  counters.validator_inputs.push({
    mode,
    retry: false,
    body: evaluateJsonBody(validatorNode, { [deterministicNode]: checked }),
  });
  let validated = await executeCode(
    validatorValidationNode,
    responseWithText(validatorResponses[0]),
    { [deterministicNode]: checked },
  );
  if (!validated.contract_valid) {
    counters.validator_calls.push(mode);
    counters.validator_inputs.push({
      mode,
      retry: true,
      body: evaluateJsonBody(validatorRetryNode, {
        [deterministicNode]: checked,
        [validatorValidationNode]: validated,
      }),
    });
    validated = await executeCode(
      validatorRetryValidationNode,
      responseWithText(validatorResponses[1] ?? validatorResponses[0]),
      { [validatorValidationNode]: validated },
    );
    if (!validated.contract_valid) {
      return executeCode(`${mode} Validator Contract Error`, validated);
    }
  }
  return executeCode(`Apply ${mode} Validation`, validated);
}

async function runM6Fixture(fixture = {}) {
  const m5 = await runFixture(fixture);
  const counters = {
    ...m5.counters,
    editor_calls: [],
    editor_inputs: [],
    validator_calls: [],
    validator_inputs: [],
    persistence_updates: 0,
  };
  let state = m5.state;

  if (state.processing_status === "PROCESSING") {
    const initialMode = state.editorial_mode;
    state = await executeCode(`Initialize ${initialMode} Editorial`, state);
    if (initialMode === "KEEP") {
      const keepDraft = await executeCode("Execute Deterministic KEEP", state);
      state = await executeCode("Validate Deterministic KEEP", keepDraft);
    } else {
      state = await executeCreativeMode(initialMode, state, fixture, counters);
      if (state.processing_status === "PROCESSING" && initialMode === "ENRICH") {
        state = await executeCode("Start MINIMAL Fallback", state);
        state = await executeCreativeMode("MINIMAL", state, fixture, counters);
      }
      if (state.processing_status === "PROCESSING") {
        state = await executeCode("Start KEEP Fallback", state);
        const keepDraft = await executeCode("Execute Deterministic KEEP", state);
        state = await executeCode("Validate Deterministic KEEP", keepDraft);
      }
    }
  }

  state = await executeCode("Prepare Reviewer Draft", state);
  if (state.m6?.draft_only && !state.m6.complete) {
    state = await executeCreativeMode("ENRICH", state, fixture, counters);
  }

  const rawBeforePersistence = plain(state.raw);
  const update = await executeCode("Prepare Terminal Persistence", state);
  counters.persistence_updates += 1;
  return { state, update, rawBeforePersistence, m5State: m5.state, counters };
}

test("workflow is inactive, import-oriented, and retains M6 behavior in the M7 sandbox export", () => {
  assert.equal(workflow.id, "edujobs-workflow-a");
  assert.equal(workflow.name, "EduJobs v2 · Vacancy Intake");
  assert.equal(workflow.versionId, "00000000-0000-4000-8000-000000000007");
  assert.equal(workflow.active, false);
  assert.equal(workflow.settings.executionOrder, "v1");
  assert.equal(nodes.get("Manual Trigger").type, "n8n-nodes-base.manualTrigger");
  assert.deepEqual(nodes.get("Generate Application UUID").parameters, {
    action: "generate",
    dataPropertyName: "generated_application_id",
    encodingType: "uuid",
  });
  const sheetsRead = nodes.get("Read Sheet Rows For Selection And Duplicates");
  assert.equal(sheetsRead.type, "n8n-nodes-base.googleSheets");
  assert.equal(sheetsRead.parameters.authentication, "serviceAccount");
  assert.equal(sheetsRead.parameters.operation, "read");
  assert.deepEqual(Object.keys(sheetsRead.credentials), ["googleApi"]);
  assert.deepEqual(sheetsRead.credentials.googleApi, {
    id: TEST_CREDENTIAL_ENVIRONMENT.N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID,
    name: TEST_CREDENTIAL_ENVIRONMENT.N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_NAME,
  });
  assert.doesNotMatch(JSON.stringify(workflow), /googleSheetsOAuth2Api/);
  assert.match(nodes.get("Prepare Selected Application").parameters.jsCode, /selected\.length !== 1/);
  assert.match(nodes.get("Prepare Selected Application").parameters.jsCode, /row_number/);
  assert.doesNotMatch(nodes.get("Prepare Selected Application").parameters.jsCode, /new URL\s*\(/);
  const configuration = nodes.get("Workflow Configuration").parameters.assignments.assignments;
  const selectionAssignment = configuration
    .find((item) => item.name === "selected_row_number");
  assert.equal(selectionAssignment.value, "={{ Number('row_number' in $json ? $json.row_number : ($env.WORKFLOW_A_RUNNER_ROW_NUMBER || $env.WORKFLOW_A_TEST_ROW_NUMBER)) }}");
  assert.equal(configuration.find((item) => item.name === "runner_mode").value, "={{ Boolean($env.WORKFLOW_A_RUNNER_ROW_NUMBER) }}");
  assert.equal(configuration.find((item) => item.name === "execution_id").value, "={{ String($execution.id || '') }}");
  assert.equal(configuration.find((item) => item.name === "workflow_version").value, "={{ $env.WORKFLOW_VERSION }}");
  assert.equal(configuration.find((item) => item.name === "config_version").value, "={{ $env.CONFIG_VERSION }}");
  assert.equal(configuration.find((item) => item.name === "editor_model").value, "={{ $env.EDITOR_MODEL }}");
  assert.equal(configuration.find((item) => item.name === "validator_model").value, "={{ $env.VALIDATOR_MODEL }}");
  assert.equal(nodes.get("Eligibility Decision").type, "n8n-nodes-base.httpRequest");
  assert.equal(nodes.get("M5 Rejected").type, "n8n-nodes-base.code");
  assert.equal(nodes.get("M5 Needs Review").type, "n8n-nodes-base.code");
  assert.equal(workflow.connections["M5 Rejected"].main[0][0].node, "Prepare Reviewer Draft");
  assert.equal(workflow.connections["M5 Needs Review"].main[0][0].node, "Prepare Reviewer Draft");
  assert.equal(workflow.connections["M5 Accepted KEEP"].main[0][0].node, "Initialize KEEP Editorial");
  assert.equal(workflow.connections["M5 Accepted MINIMAL"].main[0][0].node, "Initialize MINIMAL Editorial");
  assert.equal(workflow.connections["M5 Accepted ENRICH"].main[0][0].node, "Initialize ENRICH Editorial");
  for (const name of [
    "MINIMAL Editor", "ENRICH Editor", "MINIMAL Validator", "ENRICH Validator",
    "Execute Deterministic KEEP", "Start MINIMAL Fallback", "Start KEEP Fallback",
    "Prepare Terminal Persistence", "Persist Terminal State", "Runner Verification Required",
    "Read Sheet Rows After Runner Execution", "Build Runner Result",
  ]) assert.ok(nodes.has(name), `missing M6 node ${name}`);

  const priorTerminalNodes = [
    "Deterministic Rejection",
    "Original Source Terminal Result",
    "Original Context Contract Error",
    "Original Worker Integration Error",
    "Project Source Terminal Result",
    "Project Context Contract Error",
    "Project Worker Integration Error",
  ];
  for (const name of priorTerminalNodes) {
    assert.equal(workflow.connections[name].main[0][0].node, "Prepare Reviewer Draft", `${name} must preserve classification before optional drafting`);
  }
  const eligibilityPredecessors = [];
  for (const [from, connection] of Object.entries(workflow.connections)) {
    for (const output of connection.main) {
      for (const target of output) {
        if (target.node === "Eligibility Decision") eligibilityPredecessors.push(from);
      }
    }
  }
  assert.deepEqual(eligibilityPredecessors, ["M4 Source Acquisition Complete"]);
  const writes = workflow.nodes.filter((item) => item.type === "n8n-nodes-base.googleSheets" && item.parameters.operation === "update");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, "Persist Terminal State");
  assert.equal(workflow.connections["Persist Terminal State"].main[0][0].node, "Runner Verification Required");
  assert.equal(workflow.connections["Runner Verification Required"].main[0][0].node, "Read Sheet Rows After Runner Execution");
  assert.equal(workflow.connections["Read Sheet Rows After Runner Execution"].main[0][0].node, "Build Runner Result");

  const adjacency = Object.fromEntries(workflow.nodes.map((item) => [item.name, []]));
  for (const [from, connection] of Object.entries(workflow.connections)) {
    for (const output of connection.main) for (const target of output) adjacency[from].push(target.node);
  }
  const visited = new Set();
  const activePath = new Set();
  const visit = (name) => {
    assert.equal(activePath.has(name), false, `workflow graph must not contain a creative retry loop at ${name}`);
    if (visited.has(name)) return;
    visited.add(name);
    activePath.add(name);
    for (const target of adjacency[name]) visit(target);
    activePath.delete(name);
  };
  visit("Manual Trigger");
  visit("When Executed by Another Workflow");
  assert.equal(visited.size, workflow.nodes.length, "every node must be reachable from the one-row entrypoints");
  assert.deepEqual(Object.keys(adjacency).filter((name) => adjacency[name].length === 0), ["Build Runner Result"]);
});

test("runner verification compares pre/post Sheet snapshots and reports the execution id", async () => {
  const beforeRows = [
    { ...VALID_ROW, row_number: 2, processing_status: "NEW", processed_at: "" },
    { ...VALID_ROW, row_number: 3, "Short Description": "Another row", processing_status: "NEW", processed_at: "" },
  ];
  const afterRows = [
    { ...beforeRows[0], processing_status: "REJECTED", processed_at: "2026-09-05T10:00:00.000Z" },
    beforeRows[1],
  ];
  const result = await executeCode("Build Runner Result", afterRows, {
    "Read Sheet Rows For Selection And Duplicates": beforeRows,
    "Prepare Terminal Persistence": {
      row_number: 2,
      processing_status: "REJECTED",
      primary_reason: "SALES",
      review_reason: "",
      error_code: "",
      error_message: "",
    },
  }, { ...CONFIG, runner_mode: true, execution_id: "321" });
  assert.deepEqual(plain(result), {
    runner_result: true,
    row_number: 2,
    execution_id: "321",
    terminal_status: "REJECTED",
    reason: "SALES",
    modified_rows: [2],
    invariant_ok: true,
    input_chars: 13,
    draft_chars: 0,
    final_chars: 0,
  });
});

test("runner verification exposes an unexpected modification of another application row", async () => {
  const beforeRows = [
    { ...VALID_ROW, row_number: 2, processing_status: "NEW" },
    { ...VALID_ROW, row_number: 3, "Short Description": "Another row", processing_status: "NEW" },
  ];
  const afterRows = [
    { ...beforeRows[0], processing_status: "REJECTED" },
    { ...beforeRows[1], processing_status: "ERROR" },
  ];
  const result = await executeCode("Build Runner Result", afterRows, {
    "Read Sheet Rows For Selection And Duplicates": beforeRows,
    "Prepare Terminal Persistence": { row_number: 2, processing_status: "REJECTED", primary_reason: "SALES" },
  }, { ...CONFIG, runner_mode: true, execution_id: "322" });
  assert.deepEqual(plain(result.modified_rows), [2, 3]);
  assert.equal(result.invariant_ok, false);
});

test("secure n8n 2.37.10 runner globals accept valid HTTP(S) links", async () => {
  assert.equal(vm.runInNewContext("typeof URL", { ...N8N_2_37_10_NATIVE_GLOBALS }), "undefined");
  assert.equal(vm.runInNewContext("typeof structuredClone", { ...N8N_2_37_10_NATIVE_GLOBALS }), "undefined");

  const row = {
    ...VALID_ROW,
    "Project Website Link": " HTTPS://Example.COM:443/project#team ",
    "Original Link": "http://Jobs.Example.COM:80/vacancies/1?from=form#details",
  };
  const actual = await executeCode("Prepare Selected Application", row);
  const expected = prepareApplication(row, []);

  assert.equal(actual.processing_status, "PROCESSING");
  assert.deepEqual(JSON.parse(JSON.stringify(actual.source_annotations)), expected.source_annotations);
  assert.equal(actual.source_annotations.project_link.malformed, false);
  assert.equal(actual.source_annotations.original_link.malformed, false);
  assert.equal(actual.normalized.project_link, "https://example.com/project");
  assert.equal(actual.normalized.original_link, "http://jobs.example.com/vacancies/1?from=form");
  assert.equal(actual.normalized.project_link, expected.normalized.project_link);
  assert.equal(actual.normalized.original_link, expected.normalized.original_link);
});

test("secure n8n runtime normalizes Markdown and bare-domain Project Links", async () => {
  const cases = new Map([
    ["https://leaguesofcode.com", "https://leaguesofcode.com/"],
    ["http://leaguesofcode.com", "http://leaguesofcode.com/"],
    ["leaguesofcode.com", "https://leaguesofcode.com/"],
    ["www.leaguesofcode.com", "https://www.leaguesofcode.com/"],
    ["jobs.leaguesofcode.com", "https://jobs.leaguesofcode.com/"],
    ["leaguesofcode.com/jobs", "https://leaguesofcode.com/jobs"],
    ["company.co.uk/jobs/123", "https://company.co.uk/jobs/123"],
    [
      "[leaguesofcode.com](http://leaguesofcode.com)",
      "http://leaguesofcode.com/",
    ],
    [
      "[Leagues of Code](https://leaguesofcode.com/jobs)",
      "https://leaguesofcode.com/jobs",
    ],
  ]);

  for (const [input, expectedNormalized] of cases) {
    const row = { ...VALID_ROW, "Project Website Link": input };
    const actual = await executeCode("Prepare Selected Application", row);
    const expected = prepareApplication(row, []);
    assert.equal(actual.processing_status, "PROCESSING", input);
    assert.equal(actual.normalized.project_link, expectedNormalized, input);
    assert.equal(actual.normalized.project_link, expected.normalized.project_link, input);
    assert.equal(actual.source_annotations.project_link.malformed, false, input);
  }
});

test("secure n8n runtime keeps invalid Project Link text rejected", async () => {
  for (const input of [
    "",
    "   ",
    "company",
    "example",
    "hello world",
    "@",
    ".",
    "foo bar.com",
    "Visit leaguesofcode.com for details",
    "user@example.com",
  ]) {
    const actual = await executeCode("Prepare Selected Application", {
      ...VALID_ROW,
      "Project Website Link": input,
    });
    assert.equal(actual.processing_status, "REJECTED", JSON.stringify(input));
    assert.equal(actual.primary_reason, "NO_PROJECT_LINK", JSON.stringify(input));
  }
});

test("provider and worker nodes use configured credentials, direct endpoints, and strict schemas", () => {
  const openAiNodes = workflow.nodes.filter((item) => item.parameters.url === "https://api.openai.com/v1/responses");
  assert.equal(openAiNodes.length, 14);
  assert.ok(openAiNodes.every((item) => item.parameters.authentication === "predefinedCredentialType"));
  assert.ok(openAiNodes.every((item) => item.parameters.nodeCredentialType === "openAiApi"));
  assert.ok(openAiNodes.every((item) => item.credentials.openAiApi.id === TEST_CREDENTIAL_ENVIRONMENT.N8N_OPENAI_CREDENTIAL_ID));
  assert.ok(openAiNodes.every((item) => item.credentials.openAiApi.name === TEST_CREDENTIAL_ENVIRONMENT.N8N_OPENAI_CREDENTIAL_NAME));
  // 2026-10-06 amendment: the separate source-requirement call is retired.
  assert.equal(workflow.nodes.some((item) => /Source Requirement/.test(item.name)), false);
  assert.doesNotMatch(JSON.stringify(workflow), /source_requirement_model|SOURCE_REQUIREMENT_MODEL/);

  for (const name of ["Original Context Selector", "Project Context Selector"]) {
    const body = nodes.get(name).parameters.jsonBody;
    assert.match(body, /eligibility_model/);
    assert.match(body, /large_source_context_selection/);
    assert.match(body, /full_text_for_selection/);
    assert.doesNotMatch(body, /\.slice\(|substring\(|substr\(/);
  }

  const eligibilityNodes = openAiNodes.filter((item) => item.name === "Eligibility Decision");
  const eligibilityRetries = openAiNodes.filter((item) => item.name === "Eligibility Contract Retry");
  assert.equal(eligibilityNodes.length, 1, "M5 must have one initial combined decision call");
  assert.equal(eligibilityRetries.length, 1, "M5 must have one contract-correction retry call");
  for (const request of [...eligibilityNodes, ...eligibilityRetries]) {
    assert.equal(request.onError, "continueErrorOutput");
    assert.match(request.parameters.jsonBody, /eligibility_model/);
    assert.match(request.parameters.jsonBody, /eligibility_decision/);
    assert.match(request.parameters.jsonBody, /strict: true/);
    assert.match(request.parameters.jsonBody, /ACCEPT/);
    assert.match(request.parameters.jsonBody, /NEEDS_REVIEW/);
    assert.match(request.parameters.jsonBody, /KEEP/);
    assert.match(request.parameters.jsonBody, /MINIMAL/);
    assert.match(request.parameters.jsonBody, /ENRICH/);
    assert.match(request.parameters.jsonBody, /NO_PROJECT_LINK/);
    assert.match(request.parameters.jsonBody, /DUPLICATE_APPLICATION/);
    assert.match(request.parameters.jsonBody, /Employment format is never a reason/);
    assert.match(request.parameters.jsonBody, /never emit TEMP_PROJECT_OUTSOURCE/);
    assert.match(request.parameters.jsonBody, /short_description/);
    assert.match(request.parameters.jsonBody, /existing_application/);
    assert.match(request.parameters.jsonBody, /untrusted/i);
  }
  assert.match(eligibilityNodes[0].parameters.jsonBody, /1\. LINKS\./);
  assert.match(eligibilityNodes[0].parameters.jsonBody, /You do not write the post/);
  assert.equal(openAiNodes.some((item) => /Editorial Router/i.test(item.name)), false);

  for (const mode of ["MINIMAL", "ENRICH"]) {
    for (const suffix of ["Editor", "Editor Contract Retry"]) {
      const request = nodes.get(`${mode} ${suffix}`);
      assert.equal(request.onError, "continueErrorOutput");
      assert.match(request.parameters.jsonBody, /editor_model/);
      assert.match(request.parameters.jsonBody, /edited_content/);
      assert.match(request.parameters.jsonBody, /strict: true/);
      assert.match(request.parameters.jsonBody, /draft_description/);
      assert.match(request.parameters.jsonBody, /facts_added/);
      assert.match(request.parameters.jsonBody, /untrusted/i);
      assert.match(request.parameters.jsonBody, /never outside knowledge/i);
    }
    for (const suffix of ["Validator", "Validator Contract Retry"]) {
      const request = nodes.get(`${mode} ${suffix}`);
      assert.equal(request.onError, "continueErrorOutput");
      assert.match(request.parameters.jsonBody, /validator_model/);
      assert.match(request.parameters.jsonBody, /validation_result/);
      assert.match(request.parameters.jsonBody, /UNSUPPORTED_FACT/);
      assert.match(request.parameters.jsonBody, /OTHER_CONTRACT_VIOLATION/);
      assert.match(request.parameters.jsonBody, /not a style editor/i);
      assert.match(request.parameters.jsonBody, /a draft that is only a title, a heading or a fragment/);
      assert.match(request.parameters.jsonBody, /never fail a draft for wording, block order, structure, headings, its opening or its length/);
      assert.match(request.parameters.jsonBody, /validator_reasoning_effort/);
    }
  }
  assert.equal(openAiNodes.some((item) => /KEEP/.test(item.name)), false, "KEEP must have no provider call");

  for (const name of ["Extract Original Link", "Extract Project Link"]) {
    const worker = nodes.get(name);
    assert.match(worker.parameters.url, /content_worker_url.*\/extract/);
    assert.equal(worker.parameters.method, "POST");
    assert.equal(worker.onError, "continueErrorOutput");
  }

  for (const request of [...openAiNodes, nodes.get("Extract Original Link"), nodes.get("Extract Project Link")]) {
    assert.equal(request.parameters.contentType, "json");
    assert.equal(request.parameters.specifyBody, "json");
    assert.equal(typeof request.parameters.jsonBody, "string");
    assert.equal("body" in request.parameters, false);
    assert.equal("rawContentType" in request.parameters, false);
    assert.equal(request.parameters.options.response.response.responseFormat, "json");
  }

  const serialized = JSON.stringify(workflow);
  assert.doesNotMatch(serialized, /REPLACE_WITH_/);
  assert.doesNotMatch(serialized, /sk-[A-Za-z0-9]/);
  assert.doesNotMatch(serialized, /docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]{20,}/);
});

test("all generated HTTP body expressions parse in n8n 2.37.10", () => {
  const version = spawnSync("n8n", ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), "2.37.10");

  const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
  assert.equal(npmRoot.status, 0, npmRoot.stderr);
  const require = createRequire(import.meta.url);
  const { extendSyntax } = require(join(
    npmRoot.stdout.trim(),
    "n8n/node_modules/n8n-workflow/dist/cjs/extensions/expression-extension.js",
  ));

  const bodyExpressions = workflow.nodes
    .map((item) => ({ item, body: item.parameters.jsonBody ?? item.parameters.body }))
    .filter(({ body }) => typeof body === "string" && body.startsWith("={{"));
  assert.ok(bodyExpressions.length > 0);
  for (const { item, body } of bodyExpressions) {
    assert.doesNotThrow(
      () => extendSyntax(body),
      `${item.name} has invalid n8n expression syntax`,
    );
  }
});

test("workflow JSON imports into a disposable local n8n state directory", () => {
  const importDirectory = mkdtempSync(join(tmpdir(), "edujobs-m7-n8n-import-"));
  try {
    const result = spawnSync("n8n", ["import:workflow", "--input", workflowPath], {
      cwd: here,
      encoding: "utf8",
      env: {
        ...process.env,
        N8N_USER_FOLDER: importDirectory,
        N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: "false",
        N8N_DIAGNOSTICS_ENABLED: "false",
        N8N_VERSION_NOTIFICATIONS_ENABLED: "false",
      },
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /Successfully imported|imported.*workflow/i);
  } finally {
    rmSync(importDirectory, { recursive: true, force: true });
  }
});

test("explicit selection processes one row and preserves M3 deterministic behavior", async () => {
  const selected = {
    ...VALID_ROW,
    application_id: "existing-id",
    "Short Description": "  First line \r\n\r\n Second\tline ",
    "Project Website Link": "HTTPS://Example.COM:443/project#about",
    "Original Link": "https://example.com/jobs/selected",
  };
  const other = {
    ...VALID_ROW,
    row_number: 3,
    application_id: "other-id",
    "Original Link": "https://example.com/jobs/other",
  };
  const actual = await executeCode("Prepare Selected Application", [selected, other]);
  const expected = prepareApplication(selected, [other]);

  for (const key of [
    "application_id",
    "raw",
    "normalized",
    "normalized_contact_info", "draft_description", "final_description",
    "source_annotations",
    "duplicate",
    "processing_status",
    "eligibility_decision",
    "primary_reason",
    "reasons",
    "eligibility_evidence",
  ]) {
    assert.deepEqual(JSON.parse(JSON.stringify(actual[key])), expected[key]);
  }
  assert.equal(actual.selected_row_number, 2);

  await assert.rejects(
    () => executeCode("Prepare Selected Application", [{ ...VALID_ROW, row_number: 3 }]),
    /resolve to exactly one Google Sheets row/,
  );
  await assert.rejects(
    () => executeCode("Prepare Selected Application", [VALID_ROW, { ...VALID_ROW }]),
    /resolved=2/,
  );
});

test("embedded duplicate detection uses earlier rows and treats shared recruiting URLs conservatively", async () => {
  const futureMatch = await executeCode(
    "Prepare Selected Application",
    [
      { ...VALID_ROW, row_number: 17 },
      { ...VALID_ROW, row_number: 18, application_id: "future-id" },
    ],
    {},
    { ...CONFIG, selected_row_number: 17 },
  );
  assert.equal(futureMatch.duplicate.is_duplicate, false);
  assert.equal(futureMatch.processing_status, "PROCESSING");

  const sharedDifferentVacancy = await executeCode(
    "Prepare Selected Application",
    [
      {
        ...VALID_ROW,
        row_number: 17,
        application_id: "previous-id",
        "Short Description": "Teach English.",
        "Original Link": "https://LGEG.ru/career#vacancies",
      },
      {
        ...VALID_ROW,
        row_number: 18,
        "Short Description": "Teach mathematics.",
        "Original Link": "https://lgeg.ru/career",
      },
    ],
    {},
    { ...CONFIG, selected_row_number: 18 },
  );
  assert.equal(sharedDifferentVacancy.duplicate.is_duplicate, false);
  assert.equal(sharedDifferentVacancy.processing_status, "PROCESSING");

  const sharedSecondaryMatch = await executeCode(
    "Prepare Selected Application",
    [
      {
        ...VALID_ROW,
        row_number: 17,
        application_id: "previous-id",
        "Original Link": "https://LGEG.ru/career#vacancies",
      },
      { ...VALID_ROW, row_number: 18, "Original Link": "https://lgeg.ru/career" },
    ],
    {},
    { ...CONFIG, selected_row_number: 18 },
  );
  assert.equal(sharedSecondaryMatch.primary_reason, "DUPLICATE_APPLICATION");
  assert.equal(sharedSecondaryMatch.duplicate.match, "PROJECT_LINK_AND_SHORT_DESCRIPTION");

  for (const previous of [
    {
      ...VALID_ROW,
      row_number: 17,
      application_id: "different-project",
      "Project Website Link": "https://other.example.com/project",
      "Original Link": "https://lgeg.ru/career",
    },
    {
      ...VALID_ROW,
      row_number: 17,
      application_id: "different-description",
      "Short Description": "Teach children.",
      "Original Link": "https://lgeg.ru/career",
    },
  ]) {
    const noSecondaryMatch = await executeCode(
      "Prepare Selected Application",
      [previous, { ...VALID_ROW, row_number: 18, "Original Link": "https://lgeg.ru/career" }],
      {},
      { ...CONFIG, selected_row_number: 18 },
    );
    assert.equal(noSecondaryMatch.duplicate.is_duplicate, false, previous.application_id);
    assert.equal(noSecondaryMatch.processing_status, "PROCESSING", previous.application_id);
  }
});

test("deterministic pre-checks and duplicates short-circuit all external calls", async () => {
  for (const row of [
    { "Project Website Link": "not a url" },
    { "Contact Info": "https://example.com/form" },
    { "Contact Info": "@application_helper_bot" },
  ]) {
    const result = await runFixture({ row });
    assert.equal(result.state.processing_status, "REJECTED");
    assert.deepEqual(result.counters.worker_calls, []);
    assert.equal(result.counters.eligibility_calls, 0);
  }

  const duplicate = {
    ...VALID_ROW,
    row_number: 3,
  };
  const result = await runFixture({
    rows: [
      { ...VALID_ROW, row_number: 2, application_id: "existing-application", "Original Link": "https://example.com/jobs/1#fragment" },
      duplicate,
    ],
    config: { selected_row_number: 3 },
  });
  assert.equal(result.state.primary_reason, "DUPLICATE_APPLICATION");
  assert.deepEqual(result.counters.worker_calls, []);
  assert.equal(result.counters.eligibility_calls, 0);
});

test("both supported links are fetched; a technical failure only removes context (Stage 3)", async () => {
  const noSources = await runFixture({});
  assert.deepEqual(noSources.counters.worker_calls, ["original_link", "project_link"]);
  // An unreadable source only loses its context; the combined decision judges the rest.
  assert.equal(noSources.state.processing_status, "PROCESSING");
  assert.equal(noSources.state.sources.original_link.status, "extraction_failed");
  assert.equal(noSources.state.sources.project_link.status, "extraction_failed");

  const optionalRead = await runFixture({
    worker_responses: {
      original_link: workerSuccess("optional vacancy page"),
      project_link: workerSuccess("optional project page"),
    },
  });
  assert.equal(optionalRead.state.sources.original_link.used_context, "optional vacancy page");
  assert.equal(optionalRead.state.sources.project_link.used_context, "optional project page");
  const optionalInput = JSON.parse(optionalRead.counters.eligibility_inputs[0].input[1].content[0].text);
  assert.equal(optionalInput.untrusted_case_data.evidence_sources.original_link.content, "optional vacancy page");
  assert.equal(optionalInput.untrusted_case_data.evidence_sources.original_link.url, VALID_ROW["Original Link"]);

  const projectOnly = await runFixture({
    readable_sources: ["project_link"],
    worker_responses: { project_link: workerSuccess("complete project source") },
  });
  assert.deepEqual(projectOnly.counters.worker_calls, ["original_link", "project_link"]);
  assert.equal(projectOnly.state.sources.original_link.status, "extraction_failed");
  assert.equal(projectOnly.state.sources.project_link.used_context, "complete project source");

  const originalOnly = await runFixture({
    readable_sources: ["original_link"],
  });
  assert.deepEqual(originalOnly.counters.worker_calls, ["original_link", "project_link"]);
});

test("no separate source-requirement call runs before acquisition (2026-10-06 amendment)", async () => {
  const result = await runFixture({});
  assert.equal(result.state.source_requirement, undefined);
  assert.deepEqual(plain(result.state.m4.fetch), { original_link: true, project_link: true });
  assert.equal(result.counters.eligibility_calls, 1);
  const payload = JSON.parse(result.counters.eligibility_inputs[0].input[1].content[0].text);
  assert.equal("source_requirement" in payload.untrusted_case_data, false);
  for (const source of ["original_link", "project_link"]) {
    assert.equal("required" in payload.untrusted_case_data.evidence_sources[source], false, source);
    assert.equal(payload.untrusted_case_data.evidence_sources[source].status, "extraction_failed", source);
    assert.equal(payload.untrusted_case_data.evidence_sources[source].error_code, "FETCH_FAILED", source);
    assert.equal(payload.untrusted_case_data.evidence_sources[source].content, null, source);
  }
});

test("malformed Original Links short-circuit; social links are never fetched and the combined decision owns SOCIAL_LINK_ONLY", async () => {
  // Stage 1: the published details link must be usable.
  const malformed = await runFixture({ row: { "Original Link": "not-a-url" } });
  assert.equal(malformed.state.processing_status, "REJECTED");
  assert.equal(malformed.state.primary_reason, "LINK_BROKEN");
  assert.deepEqual(malformed.counters.worker_calls, []);
  assert.equal(malformed.counters.eligibility_calls, 0);

  // A social link alone does not affect eligibility when the rest suffices.
  const sufficient = await runFixture({ row: { "Original Link": "https://t.me/vacancy_channel" } });
  assert.equal(sufficient.state.processing_status, "PROCESSING");
  assert.deepEqual(sufficient.counters.worker_calls, ["project_link"]);
  assert.equal(sufficient.state.sources.original_link.status, "unsupported_social");
  const payload = JSON.parse(sufficient.counters.eligibility_inputs[0].input[1].content[0].text);
  assert.equal(payload.untrusted_case_data.evidence_sources.original_link.status, "unsupported_social");
  assert.equal(payload.untrusted_case_data.evidence_sources.original_link.content, null);

  const socialProject = "https://www.instagram.com/example (inst) /// https://www.tiktok.com/@example (tiktok) /// сайт в процессе разработки";
  const socialDecision = { ...ACCEPT_KEEP, decision: "REJECT", primary_reason: "SOCIAL_LINK_ONLY", reasons: ["SOCIAL_LINK_ONLY"],
    evidence: [{ reason: "SOCIAL_LINK_ONLY", source: "project_link", text: socialProject }], editorial_mode: null, editorial_reason: null };
  const rowFourSocialProject = await runFixture({
    row: {
      "Short Description": "Ищу методиста образовательных программ в онлайн-школу Teach.",
      "Project Website Link": socialProject,
      "Original Link": "https://docs.google.com/document/d/example/edit",
    },
    readable_sources: ["original_link"],
    eligibility_responses: [socialDecision],
  });
  assert.equal(rowFourSocialProject.state.processing_status, "REJECTED");
  assert.equal(rowFourSocialProject.state.primary_reason, "SOCIAL_LINK_ONLY");
  assert.deepEqual(plain(rowFourSocialProject.state.eligibility_evidence), socialDecision.evidence);
  assert.deepEqual(rowFourSocialProject.counters.worker_calls, ["original_link"]);
  assert.equal(rowFourSocialProject.counters.eligibility_calls, 1);

  // SOCIAL_LINK_ONLY needs a submitted social link; otherwise the contract retry runs.
  const misused = await runFixture({
    eligibility_responses: [{ ...socialDecision, evidence: [{ reason: "SOCIAL_LINK_ONLY", source: "short_description", text: "Teach adults." }] }],
  });
  assert.equal(misused.counters.eligibility_calls, 2);
  assert.equal(misused.state.processing_status, "ERROR");
  assert.equal(misused.state.error_code, "MALFORMED_ELIGIBILITY_OUTPUT");
  assert.match(misused.state.error_message, /SOCIAL_LINK_ONLY requires a submitted unsupported social-network link/);
});

test("a scheme-less Original Link is fetched, not rejected as LINK_BROKEN (execution 452)", async () => {
  const bareDoc = "docs.google.com/document/d/1R9OJFVn4g27Q4_zHadhPqjVFGczWVsGfKMsZAZqhKII";
  const row = { ...VALID_ROW, "Original Link": bareDoc };
  const prepared = await executeCode("Prepare Selected Application", row);
  assert.equal(prepared.raw.original_link, bareDoc);
  assert.equal(prepared.normalized.original_link, `https://${bareDoc}`);
  assert.equal(prepared.normalized.original_link, prepareApplication(row, []).normalized.original_link);
  assert.equal(prepared.source_annotations.original_link.malformed, false);

  const required = await runFixture({
    row: { "Original Link": bareDoc },
    readable_sources: ["original_link"],
  });
  assert.equal(required.state.processing_status, "PROCESSING");
  assert.equal(required.state.primary_reason, null);
  assert.deepEqual(required.counters.worker_calls, ["original_link", "project_link"]);
  const request = evaluateJsonBody("Extract Original Link", { "Plan Source Acquisition": prepared });
  assert.deepEqual(request, { url: `https://${bareDoc}` });
});

test("worker outcomes map broken, technical, and malformed responses conservatively", async () => {
  const broken = await runFixture({
    worker_responses: {
      original_link: workerFailure("LINK_BROKEN", { status: "broken" }),
    },
  });
  assert.equal(broken.state.processing_status, "REJECTED");
  assert.equal(broken.state.primary_reason, "LINK_BROKEN");
  assert.equal(broken.counters.eligibility_calls, 0);

  // A technical failure reaches the combined decision, which may ask for review.
  const unreadReview = { ...REVIEW_DECISION, review_reason: "Не удалось прочитать страницу вакансии, а заявка не описывает работу." };
  const technical = await runFixture({
    worker_responses: { original_link: workerFailure("EXTRACTION_FAILED") },
    eligibility_responses: [unreadReview],
  });
  assert.equal(technical.state.processing_status, "NEEDS_REVIEW");
  assert.equal(technical.state.review_reason, unreadReview.review_reason);
  assert.equal(technical.counters.eligibility_calls, 1);
  const payload = JSON.parse(technical.counters.eligibility_inputs[0].input[1].content[0].text);
  assert.equal(payload.untrusted_case_data.evidence_sources.original_link.status, "extraction_failed");
  assert.equal(payload.untrusted_case_data.evidence_sources.original_link.error_code, "EXTRACTION_FAILED");

  const malformed = await runFixture({
    worker_responses: { original_link: { status: "success", text: "missing contract fields" } },
  });
  assert.equal(malformed.state.processing_status, "ERROR");
  assert.equal(malformed.state.error_code, "MALFORMED_WORKER_RESPONSE");
  assert.equal(malformed.counters.eligibility_calls, 0);
});

test("links: a confirmed dead link rejects, a technical failure only removes context (Section 19.4)", async () => {
  for (const source of ["original_link", "project_link"]) {
    const dead = await runFixture({
      worker_responses: { [source]: workerFailure("LINK_BROKEN", { status: "broken", error_message: "Destination hostname does not exist" }) },
    });
    assert.equal(dead.state.processing_status, "REJECTED", source);
    assert.equal(dead.state.primary_reason, "LINK_BROKEN", source);
    assert.deepEqual(plain(dead.state.eligibility_evidence), [{ reason: "LINK_BROKEN", source, text: "Destination hostname does not exist" }], source);
    assert.equal(dead.state.m4.stage, "source_failure", source);
    assert.equal(dead.counters.eligibility_calls, 0, source);
    for (const code of ["FETCH_FAILED", "TIMEOUT", "BROWSERLESS_FAILED", "EXTRACTION_FAILED", "CONTENT_TOO_LARGE"]) {
      const skipped = await runFixture({ worker_responses: { [source]: workerFailure(code) } });
      assert.equal(skipped.state.processing_status, "PROCESSING", `${source}: ${code}`);
      assert.equal(skipped.state.review_reason, null, `${source}: ${code}`);
      assert.equal(skipped.state.sources[source].status, "extraction_failed", `${source}: ${code}`);
      assert.equal(skipped.counters.eligibility_calls, 1, `${source}: ${code}`);
    }
  }
});

test("a successfully read page is approved context for the ENRICH editor and validator", async () => {
  const page = "The project teaches adult learners online in small evening groups.";
  const result = await runM6Fixture({
    row: { "Short Description": "Teach hires a tutor to teach adults and prepare lessons." },
    worker_responses: { project_link: workerSuccess(page) },
    eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: "ENRICH" }],
    editor_responses: { ENRICH: [{ project_link_text: "Teach",
      draft_description: "Teach hires a tutor to teach adults and prepare lessons. The project teaches adult learners online.",
      facts_added: [{ fact: "The project teaches adults online.", source: "project_link", evidence: "The project teaches adult learners online" }] }] },
  });
  const editorPayload = JSON.parse(result.counters.editor_inputs[0].body.input[1].content[0].text);
  assert.deepEqual(editorPayload.untrusted_source_data.approved_external_context, { project_link: page });
  const validatorPayload = JSON.parse(result.counters.validator_inputs[0].body.input[1].content[0].text);
  assert.deepEqual(validatorPayload.untrusted_validation_data.approved_external_context, { project_link: page });
  assert.equal(result.update.processing_status, "READY_FOR_PUBLISH");
  assert.equal(result.update.final_editorial_mode, "ENRICH");
});

test("the combined decision receives the post elements, exclusions and KEEP criteria", () => {
  for (const name of ["Eligibility Decision", "Eligibility Contract Retry"]) {
    const body = nodes.get(name).parameters.jsonBody;
    assert.match(body, /A post contains, in this order and only what the permitted sources state/, name);
    assert.match(body, /Excluded material never belongs in a post/, name);
    assert.match(body, /KEEP: the submission is sufficient, already reads as such a post, contains no excluded material, its visible length/, name);
    assert.match(body, /only when genuinely unsure, prefer KEEP over MINIMAL and MINIMAL over ENRICH/, name);
    // The classifier writes nothing, so the editors' opening grammar stays out of its prompt.
    assert.doesNotMatch(body, /Мы в X приглашаем|keep the author's word order/, name);
  }
});

test("unreadable content cannot become a negative project fact", async () => {
  for (const message of ["loading placeholder", "empty document shell"]) {
    const unresolved = await runFixture({
      worker_responses: {
        original_link: workerFailure("EXTRACTION_FAILED", { error_message: message }),
      },
      eligibility_responses: [{ ...REVIEW_DECISION, review_reason: "Не удалось прочитать страницу вакансии." }],
    });
    assert.equal(unresolved.state.processing_status, "NEEDS_REVIEW", message);
    assert.equal(unresolved.state.primary_reason, null, message);
    const payload = JSON.parse(unresolved.counters.eligibility_inputs[0].input[1].content[0].text);
    // The failure is a status and a code, never page content the classifier could quote.
    assert.equal(payload.untrusted_case_data.evidence_sources.original_link.content, null, message);
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(message), message);
  }

  const substantiveUnconfirmed = await runFixture({
    readable_sources: ["original_link"],
    worker_responses: {
      original_link: workerSuccess("The page is an anonymous response form and does not identify any employer or project."),
    },
    eligibility_responses: [{
      project_link_text: "Teach",
      role_title: "Teacher",
      employer_name: null,
      decision: "REJECT",
      primary_reason: "PROJECT_NOT_CONFIRMED",
      reasons: ["PROJECT_NOT_CONFIRMED"],
      evidence: [{
        reason: "PROJECT_NOT_CONFIRMED",
        source: "original_link",
        text: "The page is an anonymous response form and does not identify any employer or project.",
      }],
      review_reason: null,
      editorial_mode: null,
      editorial_reason: null, material_gaps: [],
    }],
  });
  assert.equal(substantiveUnconfirmed.state.processing_status, "REJECTED");
  assert.equal(substantiveUnconfirmed.state.primary_reason, "PROJECT_NOT_CONFIRMED");
  assert.equal(substantiveUnconfirmed.counters.eligibility_calls, 1);

  // Evidence cannot cite a link that was not read.
  const unreadEvidence = await runFixture({
    eligibility_responses: [{ ...SALES_DECISION, primary_reason: "PROJECT_NOT_CONFIRMED", reasons: ["PROJECT_NOT_CONFIRMED"],
      evidence: [{ reason: "PROJECT_NOT_CONFIRMED", source: "original_link", text: "loading placeholder" }] }],
  });
  assert.equal(unreadEvidence.state.processing_status, "ERROR");
  assert.match(unreadEvidence.state.error_message, /not successfully acquired/);

  const confirmed404 = await runFixture({
    worker_responses: {
      original_link: workerFailure("LINK_BROKEN", {
        status: "broken",
        error_message: "Confirmed HTTP 404",
      }),
    },
  });
  assert.equal(confirmed404.state.processing_status, "REJECTED");
  assert.equal(confirmed404.state.primary_reason, "LINK_BROKEN");
  assert.equal(confirmed404.counters.eligibility_calls, 0);

  const integrationError = await executeCode(
    "Original Worker Integration Error",
    { message: "content worker unavailable" },
    {
      "Plan Source Acquisition": (await runFixture({
        stop_before_eligibility: true,
      })).state,
    },
  );
  assert.equal(integrationError.processing_status, "ERROR");
  assert.equal(integrationError.error_code, "WORKER_INTEGRATION_ERROR");
});

test("ordinary content routes directly and oversized content alone invokes strict selector", async () => {
  const decision = [{
    original_link_required: true,
    project_link_required: false,
    reasons: { original_link: "Needed.", project_link: null },
  }];
  const ordinaryText = "x".repeat(CONFIG.max_llm_source_chars);
  const ordinary = await runFixture({
    source_requirement_responses: decision,
    worker_responses: { original_link: workerSuccess(ordinaryText) },
  });
  assert.deepEqual(ordinary.counters.context_selector_calls, []);
  assert.equal(ordinary.state.sources.original_link.used_context, ordinaryText);

  const oversizedText = "A".repeat(CONFIG.max_llm_source_chars + 1) + "TAIL_SENTINEL";
  const oversized = await runFixture({
    source_requirement_responses: decision,
    worker_responses: { original_link: workerSuccess(oversizedText) },
    context_responses: {
      original_link: [{
        selected_context: "minimum relevant context",
        relation: "RELEVANT",
        reason: null,
      }],
    },
  });
  assert.deepEqual(oversized.counters.context_selector_calls, ["original_link"]);
  assert.equal(oversized.counters.context_inputs[0], oversizedText);
  assert.match(oversized.counters.context_inputs[0], /TAIL_SENTINEL$/);
  assert.equal(oversized.state.sources.original_link.used_context, "minimum relevant context");
  assert.equal("full_text_for_selection" in oversized.state.sources.original_link, false);
});

test("oversized selector gets one correction retry and never truncates its input", async () => {
  const oversizedText = "B".repeat(150) + "END_OF_COMPLETE_SOURCE";
  const result = await runFixture({
    readable_sources: ["original_link"],
    worker_responses: { original_link: workerSuccess(oversizedText) },
    context_responses: {
      original_link: ["bad-selector-json", {
        selected_context: "corrected context",
        relation: "RELEVANT",
        reason: null,
      }],
    },
  });
  assert.deepEqual(result.counters.context_selector_calls, ["original_link", "original_link"]);
  assert.equal(result.counters.context_inputs[0], oversizedText);
  assert.equal(result.state.sources.original_link.used_context, "corrected context");
});

test("combined decision emits distinct REJECTED, NEEDS_REVIEW, KEEP, MINIMAL, and ENRICH routes", async () => {
  for (const mode of ["KEEP", "MINIMAL", "ENRICH"]) {
    const result = await runFixture({
      eligibility_responses: [{
        ...ACCEPT_KEEP,
        editorial_mode: mode,
        editorial_reason: `Fixture selected ${mode}.`, material_gaps: [],
      }],
    });
    assert.equal(result.counters.eligibility_calls, 1);
    assert.equal(result.state.processing_status, "PROCESSING");
    assert.equal(result.state.eligibility_decision, "ACCEPT");
    assert.equal(result.state.editorial_mode, mode);
    assert.equal(result.state.m5.route, `ACCEPT_${mode}`);
    assert.equal(result.state.m5.complete, true);
  }

  const rejected = await runFixture({
    row: { "Short Description": "Close incoming leads and meet monthly sales targets." },
    eligibility_responses: [{
      project_link_text: "Teach", role_title: null, employer_name: null, decision: "REJECT",
      primary_reason: "SALES",
      reasons: ["SALES"],
      evidence: [{
        reason: "SALES",
        source: "short_description",
        text: "Close incoming leads and meet monthly sales targets.",
      }],
      review_reason: null,
      editorial_mode: null,
      editorial_reason: null, material_gaps: [],
    }],
  });
  assert.equal(rejected.state.processing_status, "REJECTED");
  assert.equal(rejected.state.m5.route, "REJECTED");
  assert.equal(rejected.state.editorial_mode, null);

  const review = await runFixture({
    eligibility_responses: [{
      project_link_text: "Teach", role_title: null, employer_name: null, decision: "NEEDS_REVIEW",
      primary_reason: null,
      reasons: [],
      evidence: [],
      review_reason: "The approved sources materially conflict about the employment format.",
      editorial_mode: null,
      editorial_reason: null, material_gaps: [],
    }],
  });
  assert.equal(review.state.processing_status, "NEEDS_REVIEW");
  assert.equal(review.state.m5.route, "NEEDS_REVIEW");
  assert.equal(review.state.editorial_mode, null);
});

test("post-validation enforces every decision-shape invariant and closed enums", async () => {
  const { state } = await runFixture({ stop_before_eligibility: true });
  const validReject = {
    project_link_text: "Teach", role_title: null, employer_name: null, decision: "REJECT",
    primary_reason: "SALES",
    reasons: ["SALES"],
    evidence: [{ reason: "SALES", source: "short_description", text: "Sales targets." }],
    review_reason: null,
    editorial_mode: null,
    editorial_reason: null, material_gaps: [],
  };
  const validReview = {
    project_link_text: "Teach", role_title: null, employer_name: null, decision: "NEEDS_REVIEW",
    primary_reason: null,
    reasons: [],
    evidence: [],
    review_reason: "Material source conflict.",
    editorial_mode: null,
    editorial_reason: null, material_gaps: [],
  };
  const cases = [
    ["non-object", null],
    ["extra property", { ...ACCEPT_KEEP, extra: true }],
    ["invalid decision", { ...ACCEPT_KEEP, decision: "MAYBE" }],
    ["reject primary reason", { ...validReject, primary_reason: null }],
    ["reject non-empty reasons", { ...validReject, reasons: [] }],
    ["reject primary included", { ...validReject, primary_reason: "OUT_OF_SCOPE" }],
    ["reject evidence required", { ...validReject, evidence: [] }],
    ["closed reason enum", { ...validReject, primary_reason: "MADE_UP", reasons: ["MADE_UP"] }],
    ["unique reasons", { ...validReject, reasons: ["SALES", "SALES"] }],
    ["evidence exact shape", { ...validReject, evidence: [{ ...validReject.evidence[0], extra: true }] }],
    ["evidence reason enum", { ...validReject, evidence: [{ ...validReject.evidence[0], reason: "MADE_UP" }] }],
    ["evidence source enum", { ...validReject, evidence: [{ ...validReject.evidence[0], source: "web_search" }] }],
    ["evidence text", { ...validReject, evidence: [{ ...validReject.evidence[0], text: "  " }] }],
    ["evidence reason belongs", {
      ...validReject,
      evidence: [{ reason: "OUT_OF_SCOPE", source: "short_description", text: "Retail company." }],
    }],
    ["every reason evidenced", { ...validReject, reasons: ["SALES", "OUT_OF_SCOPE"] }],
    ["reject review prohibited", { ...validReject, review_reason: "uncertain" }],
    ["reject mode prohibited", { ...validReject, editorial_mode: "KEEP" }],
    ["reject editorial reason prohibited", { ...validReject, editorial_reason: "rewrite" }],
    ["accept primary null", { ...ACCEPT_KEEP, primary_reason: "SALES" }],
    ["accept reasons empty", { ...ACCEPT_KEEP, reasons: ["SALES"] }],
    ["accept evidence empty", { ...ACCEPT_KEEP, evidence: [validReject.evidence[0]] }],
    ["accept review null", { ...ACCEPT_KEEP, review_reason: "uncertain" }],
    ["accept mode required", { ...ACCEPT_KEEP, editorial_mode: null }],
    ["accept mode enum", { ...ACCEPT_KEEP, editorial_mode: "REWRITE" }],
    ["accept reason required", { ...ACCEPT_KEEP, editorial_reason: " " }],
    ["review primary null", { ...validReview, primary_reason: "SALES" }],
    ["review reasons empty", { ...validReview, reasons: ["SALES"] }],
    ["review evidence empty", { ...validReview, evidence: [validReject.evidence[0]] }],
    ["review reason required", { ...validReview, review_reason: "" }],
    ["review mode prohibited", { ...validReview, editorial_mode: "KEEP" }],
    ["review editorial reason prohibited", { ...validReview, editorial_reason: "rewrite" }],
  ];

  for (const [label, value] of cases) {
    const envelope = await executeCode(
      "Validate Eligibility Decision",
      responseWithText(value),
      { "M4 Source Acquisition Complete": state },
    );
    assert.equal(envelope.contract_valid, false, label);
    assert.equal(typeof envelope.contract_error, "string", label);
  }
});

test("multiple genuinely independent rejection reasons require and preserve evidence for each", async () => {
  const result = await runFixture({
    row: { "Short Description": "Sell retail subscriptions and close leads against revenue targets." },
    eligibility_responses: [{
      project_link_text: "Teach", role_title: null, employer_name: null, decision: "REJECT",
      primary_reason: "SALES",
      reasons: ["SALES", "OUT_OF_SCOPE"],
      evidence: [
        { reason: "SALES", source: "short_description", text: "close leads against revenue targets" },
        { reason: "OUT_OF_SCOPE", source: "short_description", text: "retail subscriptions" },
      ],
      review_reason: null,
      editorial_mode: null,
      editorial_reason: null, material_gaps: [],
    }],
  });
  assert.equal(result.state.processing_status, "REJECTED");
  assert.deepEqual(plain(result.state.reasons), ["SALES", "OUT_OF_SCOPE"]);
  assert.deepEqual(plain(result.state.eligibility_evidence.map((item) => item.reason)), ["SALES", "OUT_OF_SCOPE"]);
});

test("temporary and project-based vacancies proceed normally while independent rejection reasons still apply", async () => {
  const temporaryDescription = "Temporary contract to develop an online mathematics course for an EdTech project called Teach.";
  const publishable = await runM6Fixture({
    row: { "Short Description": temporaryDescription },
  });
  assert.equal(publishable.state.processing_status, "READY_FOR_PUBLISH");
  assert.equal(publishable.state.eligibility_decision, "ACCEPT");
  assert.equal(publishable.state.primary_reason, null);
  assert.deepEqual(plain(publishable.state.reasons), []);

  for (const fixture of [
    {
      code: "SALES",
      description: "Temporary contract to close leads and meet sales targets for an EdTech project.",
      evidence: "close leads and meet sales targets",
    },
    {
      code: "OUT_OF_SCOPE",
      description: "Temporary contract to manage logistics for a retail outsourcing company.",
      evidence: "retail outsourcing company",
    },
  ]) {
    const rejected = await runM6Fixture({
      row: { "Short Description": fixture.description },
      eligibility_responses: [{
        project_link_text: "Teach", role_title: null, employer_name: null, decision: "REJECT",
        primary_reason: fixture.code,
        reasons: [fixture.code],
        evidence: [{
          reason: fixture.code,
          source: "short_description",
          text: fixture.evidence,
        }],
        review_reason: null,
        editorial_mode: null,
        editorial_reason: null, material_gaps: [],
      }],
    });
    assert.equal(rejected.state.processing_status, "REJECTED", fixture.code);
    assert.equal(rejected.state.primary_reason, fixture.code, fixture.code);
    assert.deepEqual(plain(rejected.state.reasons), [fixture.code], fixture.code);
  }
});

test("eligibility prompts preserve the social-impact and employee-engagement policy on initial and retry calls", async () => {
  const result = await runFixture({
    eligibility_responses: ["invalid eligibility response", ACCEPT_KEEP],
  });
  assert.equal(result.counters.eligibility_calls, 2);

  for (const request of result.counters.eligibility_inputs) {
    const prompt = request.input[0].content[0].text;
    assert.match(prompt, /social impact or a nonprofit mission, and volunteering/);
    assert.match(prompt, /A verified social-impact or volunteering organization need not be educational, but this never admits an arbitrary commercial employer/);
    assert.match(prompt, /roles in corporate culture, employee engagement, internal community, employee experience and volunteer engagement or development/);
    assert.match(prompt, /ordinary recruiting or talent acquisition, generic back-office operations/);
    assert.match(prompt, /generic administrative HR or operations work at an in-scope employer stays NON_CORE_ADMIN_OPS unless it directly serves learning, program delivery, volunteer development or mission-critical community operations/);
    assert.match(prompt, /Apply the "any company" test only after these allowances/);
  }
});

test("social-impact employers and mission-related culture, engagement, and volunteer roles can publish", async () => {
  const fixtures = [
    {
      name: "verified volunteering nonprofit",
      description: "Data analyst for impact measurement at a nonprofit coordinating community volunteer programs.",
      project_context: "The employer is a registered nonprofit whose primary mission is coordinating community volunteering programs.",
    },
    {
      name: "corporate culture at education organization",
      description: "Corporate Culture Manager supporting staff community and culture across an education organization.",
      project_context: "The employer is a verified education organization operating schools and teacher-learning programs.",
    },
    {
      name: "employee engagement at social-impact organization",
      description: "Employee Engagement Lead improving employee experience at a social-impact nonprofit.",
      project_context: "The employer is a verified social-impact nonprofit delivering community inclusion programs.",
    },
    {
      name: "mission-related volunteer development and community",
      description: "Volunteer Development and Community Coordinator responsible for training volunteers and operating the mission community.",
      project_context: "The verified nonprofit's primary mission is a volunteer-led community program, and trained volunteers deliver that program.",
    },
  ];

  for (const fixture of fixtures) {
    const result = await runM6Fixture({
      row: { "Short Description": "Teach. " + fixture.description },
      readable_sources: ["project_link"],
      worker_responses: { project_link: workerSuccess(fixture.project_context) },
      context_responses: {
        project_link: [{
          selected_context: fixture.project_context,
          relation: "RELEVANT",
          reason: null,
        }],
      },
      eligibility_responses: [{
        ...ACCEPT_KEEP,
        editorial_reason: `${fixture.name} is eligible and already publishable.`, material_gaps: [],
      }],
    });
    assert.equal(result.state.processing_status, "READY_FOR_PUBLISH", fixture.name);
    assert.equal(result.state.eligibility_decision, "ACCEPT", fixture.name);
    assert.equal(result.state.primary_reason, null, fixture.name);
    assert.deepEqual(plain(result.state.reasons), [], fixture.name);
    assert.deepEqual(result.counters.worker_calls, ["original_link", "project_link"], fixture.name);
    assert.equal(result.state.sources.project_link.used_context, fixture.project_context, fixture.name);
  }
});

test("generic commercial, recruiting, payroll, office, and HR operations roles remain rejected", async () => {
  const fixtures = [
    {
      name: "recruiter at generic commercial company",
      code: "OUT_OF_SCOPE",
      description: "Recruiter hiring sales and support staff for a generic consumer retail company.",
      evidence: "generic consumer retail company",
      project_context: "The employer is a commercial consumer-retail company with no education, research, social-impact, nonprofit, or volunteering mission.",
    },
    {
      name: "ordinary recruiter at education organization",
      code: "NON_CORE_ADMIN_OPS",
      description: "Talent Acquisition Recruiter handling ordinary hiring pipelines and candidate sourcing for all departments.",
      evidence: "ordinary hiring pipelines and candidate sourcing",
      project_context: "The employer is a verified education organization operating schools.",
    },
    {
      name: "payroll and accounting at social-impact organization",
      code: "NON_CORE_ADMIN_OPS",
      description: "Payroll Accountant processing salaries, reconciliations, and routine payroll reports.",
      evidence: "processing salaries, reconciliations, and routine payroll reports",
      project_context: "The employer is a verified social-impact nonprofit delivering community programs.",
    },
    {
      name: "office administrator at education organization",
      code: "NON_CORE_ADMIN_OPS",
      description: "Office Administrator managing supplies, meeting rooms, mail, and routine office paperwork.",
      evidence: "supplies, meeting rooms, mail, and routine office paperwork",
      project_context: "The employer is a verified education organization operating learning programs.",
    },
    {
      name: "generic HR operations without mission function",
      code: "NON_CORE_ADMIN_OPS",
      description: "HR Operations Specialist maintaining personnel files, standard HR systems, and routine HR administration.",
      evidence: "personnel files, standard HR systems, and routine HR administration",
      project_context: "The employer is a verified research nonprofit, but this role has no learning, program-delivery, community, or volunteer-development function.",
    },
  ];

  for (const fixture of fixtures) {
    const result = await runM6Fixture({
      row: { "Short Description": fixture.description },
      readable_sources: ["project_link"],
      worker_responses: { project_link: workerSuccess(fixture.project_context) },
      context_responses: {
        project_link: [{
          selected_context: fixture.project_context,
          relation: "RELEVANT",
          reason: null,
        }],
      },
      eligibility_responses: [{
        project_link_text: "Teach", role_title: null, employer_name: null, decision: "REJECT",
        primary_reason: fixture.code,
        reasons: [fixture.code],
        evidence: [{
          reason: fixture.code,
          source: "short_description",
          text: fixture.evidence,
        }],
        review_reason: null,
        editorial_mode: null,
        editorial_reason: null, material_gaps: [],
      }],
    });
    assert.equal(result.state.processing_status, "REJECTED", fixture.name);
    assert.equal(result.state.eligibility_decision, "REJECT", fixture.name);
    assert.equal(result.state.primary_reason, fixture.code, fixture.name);
    assert.deepEqual(plain(result.state.reasons), [fixture.code], fixture.name);
    assert.deepEqual(result.counters.worker_calls, ["original_link", "project_link"], fixture.name);
    assert.equal(result.state.sources.project_link.used_context, fixture.project_context, fixture.name);
  }
});

test("obsolete TEMP_PROJECT_OUTSOURCE output is invalid under the deterministic eligibility contract", async () => {
  const { state } = await runFixture({ stop_before_eligibility: true });
  const removedReason = {
    project_link_text: "Teach", role_title: null, employer_name: null, decision: "REJECT",
    primary_reason: "TEMP_PROJECT_OUTSOURCE",
    reasons: ["TEMP_PROJECT_OUTSOURCE"],
    evidence: [{
      reason: "TEMP_PROJECT_OUTSOURCE",
      source: "short_description",
      text: "Temporary contract.",
    }],
    review_reason: null,
    editorial_mode: null,
    editorial_reason: null, material_gaps: [],
  };
  const envelope = await executeCode(
    "Validate Eligibility Decision",
    responseWithText(removedReason),
    { "M4 Source Acquisition Complete": state },
  );
  assert.equal(envelope.contract_valid, false);
  assert.match(envelope.contract_error, /closed rejection enum/);
});

test("eligibility input isolates approved evidence and preserves M4 source context and relations", async () => {
  const fixture = {
    readable_sources: ["original_link", "project_link"],
    worker_responses: {
      original_link: workerSuccess("Original vacancy evidence."),
      project_link: workerSuccess("P".repeat(140) + " wrong target evidence"),
    },
    context_responses: {
      project_link: [{
        selected_context: "Wrong project target fragment.",
        relation: "WRONG_TARGET",
        reason: "The page identifies an unrelated retail company.",
      }],
    },
    eligibility_responses: [{
      project_link_text: "Teach", role_title: null, employer_name: null, decision: "REJECT",
      primary_reason: "WRONG_LINK_TARGET",
      reasons: ["WRONG_LINK_TARGET"],
      evidence: [{
        reason: "WRONG_LINK_TARGET",
        source: "project_link",
        text: "Wrong project target fragment.",
      }],
      review_reason: null,
      editorial_mode: null,
      editorial_reason: null, material_gaps: [],
    }],
  };
  const before = await runFixture({ ...fixture, stop_before_eligibility: true });
  const after = await runFixture(fixture);
  const request = after.counters.eligibility_inputs[0];
  assert.equal(request.model, CONFIG.eligibility_model);
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.text.format.name, "eligibility_decision");
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.schema.additionalProperties, false);
  assert.deepEqual(request.text.format.schema.properties.primary_reason.enum, [...EXPECTED_REJECTION_REASONS, null]);
  assert.deepEqual(request.text.format.schema.properties.reasons.items.enum, EXPECTED_REJECTION_REASONS);
  assert.deepEqual(request.text.format.schema.properties.evidence.items.properties.reason.enum, EXPECTED_REJECTION_REASONS);
  assert.deepEqual(request.text.format.schema.properties.evidence.items.properties.source.enum, EXPECTED_EVIDENCE_SOURCES);
  const userPayload = JSON.parse(request.input[1].content[0].text);
  assert.deepEqual(Object.keys(userPayload), ["untrusted_case_data", "workflow_metadata"]);
  // Section 13.0.1: the classifier sees the soft budget and the submission's visible length.
  assert.deepEqual(userPayload.workflow_metadata, {
    max_visible_chars: CONFIG.max_publication_description_chars,
    short_description_visible_chars: [...VALID_ROW["Short Description"]].length,
  });
  const caseData = userPayload.untrusted_case_data;
  assert.deepEqual(Object.keys(caseData), ["evidence_sources"]);
  assert.deepEqual(Object.keys(caseData.evidence_sources), EXPECTED_EVIDENCE_SOURCES);
  assert.equal(caseData.evidence_sources.original_link.content, "Original vacancy evidence.");
  assert.equal(caseData.evidence_sources.original_link.status, "success");
  assert.equal(caseData.evidence_sources.original_link.title, "Vacancy");
  // Directly passed content was never judged, so no relation is shown for it.
  assert.equal("selector_relation" in caseData.evidence_sources.original_link, false);
  assert.equal(caseData.evidence_sources.project_link.content, "Wrong project target fragment.");
  assert.equal(caseData.evidence_sources.project_link.selector_relation, "WRONG_TARGET");
  assert.equal(caseData.evidence_sources.project_link.selector_reason, "The page identifies an unrelated retail company.");
  assert.equal(caseData.evidence_sources.existing_application, null);
  assert.equal("full_text_for_selection" in caseData.evidence_sources.project_link, false);
  assert.deepEqual(plain(after.state.source_annotations), plain(before.state.source_annotations));
  assert.deepEqual(plain(after.state.sources), plain(before.state.sources));
  assert.equal(after.state.m5.route, "REJECTED");
});

test("post-validation rejects unavailable external and nonexistent duplicate evidence", async () => {
  const { state } = await runFixture({ stop_before_eligibility: true });
  for (const source of ["original_link", "project_link", "existing_application"]) {
    const value = {
      project_link_text: "Teach", role_title: null, employer_name: null, decision: "REJECT",
      primary_reason: "WRONG_LINK_TARGET",
      reasons: ["WRONG_LINK_TARGET"],
      evidence: [{ reason: "WRONG_LINK_TARGET", source, text: "Unsupported evidence fixture." }],
      review_reason: null,
      editorial_mode: null,
      editorial_reason: null, material_gaps: [],
    };
    const envelope = await executeCode(
      "Validate Eligibility Decision",
      responseWithText(value),
      { "M4 Source Acquisition Complete": state },
    );
    assert.equal(envelope.contract_valid, false, source);
    assert.match(envelope.contract_error, /not successfully acquired|duplicate match/);
  }
});

test("prior context-selector terminal failure bypasses the combined decision", async () => {
  const result = await runFixture({
    readable_sources: ["original_link"],
    worker_responses: { original_link: workerSuccess("X".repeat(150)) },
    context_responses: { original_link: ["bad", "still bad"] },
  });
  assert.equal(result.state.processing_status, "ERROR");
  assert.equal(result.state.error_code, "MALFORMED_CONTEXT_SELECTOR_OUTPUT");
  assert.equal(result.counters.eligibility_calls, 0);
});

test("malformed eligibility output retries exactly once, then corrects or routes to ERROR", async () => {
  const corrected = await runFixture({
    eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: null }, {
      ...ACCEPT_KEEP,
      editorial_mode: "MINIMAL",
      editorial_reason: "Minor structural cleanup is useful.", material_gaps: [],
    }],
  });
  assert.equal(corrected.counters.eligibility_calls, 2);
  assert.equal(corrected.state.processing_status, "PROCESSING");
  assert.equal(corrected.state.m5.route, "ACCEPT_MINIMAL");
  assert.equal(corrected.counters.eligibility_inputs[1].input[1].content[0].text.includes("contract_error"), true);

  const failed = await runFixture({
    eligibility_responses: ["not-json", "still-not-json", ACCEPT_KEEP],
  });
  assert.equal(failed.counters.eligibility_calls, 2);
  assert.equal(failed.state.processing_status, "ERROR");
  assert.equal(failed.state.error_code, "MALFORMED_ELIGIBILITY_OUTPUT");
  assert.equal(failed.state.m5.route, "ERROR");
  assert.equal(failed.state.editorial_mode, null);
});

test("eligibility request integration failures map to ERROR without an editor path", async () => {
  const { state } = await runFixture({ stop_before_eligibility: true });
  const failed = await executeCode(
    "Eligibility Integration Error",
    { message: "mock provider unavailable" },
    { "M4 Source Acquisition Complete": state },
  );
  assert.equal(failed.processing_status, "ERROR");
  assert.equal(failed.error_code, "ELIGIBILITY_INTEGRATION_ERROR");
  assert.equal(failed.m5.route, "ERROR");
  assert.equal(failed.editorial_mode, null);
});

test("KEEP performs only deterministic cleanup, never calls a provider, and fails conservatively", async () => {
  const ready = await runM6Fixture({
    row: { "Short Description": "  Teach adults. \r\n\r\n  Evening schedule.  " },
  });
  assert.equal(ready.state.processing_status, "READY_FOR_PUBLISH");
  assert.equal(ready.state.initial_editorial_mode, "KEEP");
  assert.equal(ready.state.final_editorial_mode, "KEEP");
  assert.equal(ready.state.final_description, linked("Teach adults.\n\nEvening schedule."));
  assert.deepEqual(plain(ready.state.facts_added), []);
  assert.deepEqual(ready.counters.editor_calls, []);
  assert.deepEqual(ready.counters.validator_calls, []);
  assert.deepEqual(plain(ready.state.validation_history), [
    { attempt: 1, mode: "KEEP", decision: "PASS", issues: [] },
  ]);

  const review = await runM6Fixture({ row: { "Short Description": " \r\n\t " } });
  assert.equal(review.state.processing_status, "NEEDS_REVIEW");
  assert.equal(review.state.initial_editorial_mode, "KEEP");
  assert.equal(review.state.final_editorial_mode, null);
  assert.equal(review.state.final_description, null);
  assert.match(review.state.review_reason, /Текст не прошёл проверку для автоматической публикации/);
  assert.deepEqual(review.counters.editor_calls, []);
  assert.deepEqual(review.counters.validator_calls, []);
  assert.deepEqual(plain(review.state.validation_history), [
    { attempt: 1, mode: "KEEP", decision: "FAIL", issues: ["OTHER_CONTRACT_VIOLATION"] },
  ]);
});

test("MINIMAL and ENRICH editor inputs are isolated to their approved sources", async () => {
  const minimalDescription = "Teach adults. ORIGINAL_ONLY_SENTINEL";
  const minimal = await runM6Fixture({
    row: { "Short Description": minimalDescription },
    eligibility_responses: [{
      ...ACCEPT_KEEP,
      editorial_mode: "MINIMAL",
      editorial_reason: "Punctuation cleanup is useful.", material_gaps: [],
    }],
    editor_responses: {
      MINIMAL: [{ project_link_text: "Teach", draft_description: "Teach adults — ORIGINAL_ONLY_SENTINEL.", facts_added: [] }],
    },
  });
  const minimalRequest = minimal.counters.editor_inputs[0].body;
  assert.equal(minimalRequest.model, CONFIG.editor_model);
  assert.equal(minimalRequest.text.format.name, "edited_content");
  assert.equal(minimalRequest.text.format.strict, true);
  assert.deepEqual(minimalRequest.text.format.schema.required, ["draft_description", "facts_added", "project_link_text"]);
  const minimalPayload = JSON.parse(minimalRequest.input[1].content[0].text);
  assert.deepEqual(plain(minimalPayload), {
    untrusted_source_data: { short_description: minimalDescription },
    workflow_metadata: editorMetadata(minimalDescription),
  });
  assert.doesNotMatch(JSON.stringify(minimalPayload), /example\.com|Contact Info|approved_external_context/);
  const minimalValidator = JSON.parse(minimal.counters.validator_inputs[0].body.input[1].content[0].text);
  assert.deepEqual(plain(minimalValidator.untrusted_validation_data.approved_external_context), {});

  const enrich = await runM6Fixture({
    row: { "Short Description": "Teach adults." },
    readable_sources: ["original_link", "project_link"],
    worker_responses: {
      original_link: workerSuccess("Evening groups are part of the role."),
      project_link: workerSuccess("The project teaches adult learners."),
    },
    eligibility_responses: [{
      ...ACCEPT_KEEP,
      editorial_mode: "ENRICH",
      editorial_reason: "Two material approved details are missing.", material_gaps: [],
    }],
    editor_responses: {
      ENRICH: [{
        project_link_text: "Teach", draft_description: "Teach adults in evening groups for a project focused on adult learners.",
        facts_added: [
          { fact: "The role includes evening groups.", source: "original_link", evidence: "Evening groups are part of the role." },
          { fact: "The project teaches adults.", source: "project_link", evidence: "The project teaches adult learners." },
        ],
      }],
    },
  });
  const enrichRequest = enrich.counters.editor_inputs[0].body;
  assert.equal(enrichRequest.model, CONFIG.editor_model);
  const enrichPayload = JSON.parse(enrichRequest.input[1].content[0].text);
  assert.deepEqual(Object.keys(enrichPayload.untrusted_source_data).sort(), ["approved_external_context", "short_description"]);
  assert.deepEqual(plain(enrichPayload.untrusted_source_data.approved_external_context), {
    original_link: "Evening groups are part of the role.",
    project_link: "The project teaches adult learners.",
  });
  assert.doesNotMatch(JSON.stringify(enrichPayload), /jobs@example\.com|https:\/\/example\.com/);
  const enrichValidator = JSON.parse(enrich.counters.validator_inputs[0].body.input[1].content[0].text);
  assert.deepEqual(plain(enrichValidator.untrusted_validation_data.approved_external_context), {
    original_link: "Evening groups are part of the role.",
    project_link: "The project teaches adult learners.",
  });
  assert.equal(enrich.state.processing_status, "READY_FOR_PUBLISH");
  assert.equal(enrich.state.final_editorial_mode, "ENRICH");
});

test("EditedContent post-validation enforces the strict MINIMAL and ENRICH machine contract", async () => {
  for (const mode of ["MINIMAL", "ENRICH"]) {
    const m5 = await runFixture({
      eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: mode, editorial_reason: `${mode} fixture.` }],
    });
    const initialized = await executeCode(`Initialize ${mode} Editorial`, m5.state);
    const begun = await executeCode(`Begin ${mode} Attempt`, initialized);
    const validationNode = `Validate ${mode} EditedContent`;
    const valid = await executeCode(
      validationNode,
      responseWithText({
        project_link_text: "Teach", draft_description: "Draft.",
        facts_added: mode === "MINIMAL" ? [] : [{ fact: "Fact.", source: "original_link", evidence: "Evidence." }],
      }),
      { [`Begin ${mode} Attempt`]: begun },
    );
    assert.equal(valid.contract_valid, true, mode);

    const invalid = [
      null,
      { project_link_text: "Teach", draft_description: "Draft." },
      { project_link_text: "Teach", draft_description: "Draft.", facts_added: [], extra: true },
      { project_link_text: "Teach", draft_description: 123, facts_added: [] },
      { project_link_text: "Teach", draft_description: "Draft.", facts_added: {} },
      { project_link_text: "Teach", draft_description: "Draft.", facts_added: [null] },
      { project_link_text: "Teach", draft_description: "Draft.", facts_added: [{ fact: "x", source: "web_search", evidence: "y" }] },
      { project_link_text: "Teach", draft_description: "Draft.", facts_added: [{ fact: "x", source: "original_link", evidence: "y", extra: true }] },
    ];
    for (const value of invalid) {
      const envelope = await executeCode(
        validationNode,
        responseWithText(value),
        { [`Begin ${mode} Attempt`]: begun },
      );
      assert.equal(envelope.contract_valid, false, `${mode}: ${JSON.stringify(value)}`);
    }
  }
});

test("deterministic output checks enforce MINIMAL and ENRICH facts and source evidence", async () => {
  const minimalWithFact = await runM6Fixture({
    eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: "MINIMAL", editorial_reason: "Cleanup." }],
    editor_responses: {
      MINIMAL: [{
        project_link_text: "Teach", draft_description: "Teach adults with a supplied laptop.",
        facts_added: [{ fact: "Laptop supplied.", source: "project_link", evidence: "Laptop supplied." }],
      }],
    },
  });
  assert.deepEqual(minimalWithFact.counters.validator_calls, []);
  assert.equal(minimalWithFact.state.final_editorial_mode, "KEEP");
  assert.deepEqual(plain(minimalWithFact.state.validation_history), [
    { attempt: 1, mode: "MINIMAL", decision: "FAIL", issues: ["OTHER_CONTRACT_VIOLATION"] },
    { attempt: 2, mode: "KEEP", decision: "PASS", issues: [] },
  ]);

  const baseEnrich = {
    readable_sources: ["original_link"],
    worker_responses: { original_link: workerSuccess("The schedule is 20 hours per week.") },
    eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: "ENRICH", editorial_reason: "Schedule is material." }],
  };
  const supported = await runM6Fixture({
    ...baseEnrich,
    editor_responses: { ENRICH: [{
      project_link_text: "Teach", draft_description: "Teach adults, 20 hours per week.",
      facts_added: [{ fact: "20 hours per week.", source: "original_link", evidence: "20 hours per week" }],
    }] },
  });
  assert.equal(supported.state.final_editorial_mode, "ENRICH");
  assert.deepEqual(plain(supported.state.facts_added), [
    { fact: "20 hours per week.", source: "original_link", evidence: "20 hours per week" },
  ]);

  const forbidden = await runM6Fixture({
    ...baseEnrich,
    editor_responses: { ENRICH: [{
      project_link_text: "Teach", draft_description: "Teach adults. Details: https://unapproved.example/job",
      facts_added: [{ fact: "Office equipment supplied.", source: "project_link", evidence: "Office equipment supplied." }],
    }] },
  });
  assert.equal(forbidden.state.final_editorial_mode, "MINIMAL");
  assert.deepEqual(forbidden.counters.validator_calls, ["MINIMAL"]);
  assert.deepEqual(plain(forbidden.state.validation_history[0]), {
    attempt: 1,
    mode: "ENRICH",
    decision: "FAIL",
    issues: ["FORBIDDEN_SOURCE_USAGE"],
  });

  const unsupported = await runM6Fixture({
    ...baseEnrich,
    editor_responses: { ENRICH: [{
      project_link_text: "Teach", draft_description: "Teach adults, 40 hours per week.",
      facts_added: [{ fact: "40 hours per week.", source: "original_link", evidence: "40 hours per week" }],
    }] },
  });
  assert.equal(unsupported.state.final_editorial_mode, "MINIMAL");
  assert.equal(unsupported.state.validation_history[0].issues.includes("UNSUPPORTED_FACT"), true);
});

test("title-only MINIMAL fallback cannot publish when the extracted vacancy body is substantial", async () => {
  const title = "Менеджер по дипломам в Teach";
  const extractedVacancy = [
    "Онлайн-школа помогает студентам готовить и защищать дипломные проекты.",
    "Обязанности: сопровождать студентов, координировать экспертов и контролировать сроки подготовки дипломов.",
    "Требования: опыт в образовательных проектах, грамотная письменная речь и уверенная работа с документами.",
    "Условия: удалённая работа, полная занятость и фиксированный рабочий график.",
  ].join("\n");
  const result = await runM6Fixture({
    row: { "Short Description": title },
    config: { max_llm_source_chars: 900 },
    readable_sources: ["original_link"],
    worker_responses: { original_link: workerSuccess(extractedVacancy, { title }) },
    eligibility_responses: [{
      ...ACCEPT_KEEP,
      editorial_mode: "ENRICH",
      editorial_reason: "The submitted title needs the approved vacancy details.", material_gaps: [],
    }],
    editor_responses: {
      ENRICH: [{
        project_link_text: "Teach", draft_description: `${title}\n\n${extractedVacancy}`,
        facts_added: [{ fact: extractedVacancy, source: "original_link", evidence: extractedVacancy }],
      }],
      MINIMAL: [{ project_link_text: "Teach", draft_description: title, facts_added: [] }],
    },
    validator_responses: {
      ENRICH: [{
        decision: "FAIL",
        issues: [{
          type: "UNSUPPORTED_FACT", text: "Rejected ENRICH fixture.",
          reason: "Exercise the ENRICH to MINIMAL fallback path.",
        }],
      }],
      MINIMAL: [VALIDATION_PASS],
    },
  });

  assert.equal(result.state.processing_status, "NEEDS_REVIEW");
  assert.equal(result.state.sources.original_link.title, title);
  assert.equal(result.state.final_editorial_mode, null);
  assert.equal(result.state.final_description, null);
  assert.deepEqual(result.counters.validator_calls, ["ENRICH"]);
  assert.deepEqual(plain(result.state.validation_history), [
    { attempt: 1, mode: "ENRICH", decision: "FAIL", issues: ["UNSUPPORTED_FACT"] },
    { attempt: 2, mode: "MINIMAL", decision: "FAIL", issues: ["MEANING_LOST"] },
    { attempt: 3, mode: "KEEP", decision: "FAIL", issues: ["MEANING_LOST"] },
  ]);
});

test("substantial Short Description cannot collapse to its title, a heading, or one trivial fragment", async () => {
  const source = [
    "Менеджер по дипломам в Teach",
    "Онлайн-школа помогает студентам готовить дипломные проекты вместе с отраслевыми экспертами.",
    "Обязанности: сопровождать студентов, распределять задачи экспертам и контролировать сроки.",
    "Требования: опыт координации образовательных проектов, грамотная речь и внимательность к документам.",
    "Условия: удалённый формат, полная занятость и рабочий день по московскому времени.",
  ].join("\n");

  for (const [label, finalDescription] of [
    ["title only", "Менеджер по дипломам в Teach"],
    ["heading only", "Требования"],
    ["trivial fragment", "Удалённый формат работы"],
  ]) {
    const result = await runM6Fixture({
      row: { "Short Description": source },
      eligibility_responses: [{
        ...ACCEPT_KEEP,
        editorial_mode: "MINIMAL",
        editorial_reason: "Condense the submitted copy.", material_gaps: [],
      }],
      editor_responses: { MINIMAL: [{ project_link_text: "Teach", draft_description: finalDescription, facts_added: [] }] },
      validator_responses: { MINIMAL: [VALIDATION_PASS] },
    });

    assert.equal(result.state.processing_status, "READY_FOR_PUBLISH", label);
    assert.equal(result.state.final_editorial_mode, "KEEP", label);
    assert.equal(result.state.final_description, linked(source), label);
    assert.deepEqual(result.counters.validator_calls, [], label);
    assert.deepEqual(plain(result.state.validation_history), [
      { attempt: 1, mode: "MINIMAL", decision: "FAIL", issues: finalDescription.includes("Teach") ? ["MEANING_LOST"] : ["OTHER_CONTRACT_VIOLATION", "MEANING_LOST"] },
      { attempt: 2, mode: "KEEP", decision: "PASS", issues: [] },
    ], label);
  }
});

test("concise but complete MINIMAL output preserves the core vacancy", async () => {
  const source = [
    "Методист образовательных программ в онлайн-школу Teach",
    "Команда создаёт практические онлайн-курсы для взрослых и работает вместе с отраслевыми экспертами.",
    "Задачи: разрабатывать программы и учебные материалы, координировать экспертов, проверять качество уроков и улучшать курсы по обратной связи.",
    "Требования: не менее трёх лет опыта в методической работе, умение проектировать обучение и уверенная письменная коммуникация.",
    "Условия: удалённая работа, полная занятость, гибкое начало рабочего дня и оформление по договору.",
    "Мы также подробно рассказываем о внутренних встречах, истории команды и процессе адаптации новых коллег.",
  ].join("\n");
  const concise = [
    "Методист образовательных программ в онлайн-школу Teach.",
    "Задачи: разрабатывать программы и материалы, координировать экспертов и контролировать качество уроков.",
    "Требования: опыт методической работы от трёх лет и навыки проектирования обучения.",
    "Условия: удалённо, полная занятость, гибкое начало дня, договор.",
  ].join("\n");
  const result = await runM6Fixture({
    row: { "Short Description": source },
    eligibility_responses: [{
      ...ACCEPT_KEEP,
      editorial_mode: "MINIMAL",
      editorial_reason: "Remove repetition while preserving the core vacancy.", material_gaps: [],
    }],
    editor_responses: { MINIMAL: [{ project_link_text: "Teach", draft_description: concise, facts_added: [] }] },
  });

  assert.equal(result.state.processing_status, "READY_FOR_PUBLISH");
  assert.equal(result.state.final_editorial_mode, "MINIMAL");
  assert.equal(result.state.final_description, linked(concise));
  assert.deepEqual(result.counters.validator_calls, ["MINIMAL"]);
  assert.deepEqual(plain(result.state.validation_history), [
    { attempt: 1, mode: "MINIMAL", decision: "PASS", issues: [] },
  ]);
});

test("MINIMAL may remove navigation and footer noise while preserving the actual vacancy", async () => {
  const vacancy = [
    "Координатор образовательных программ в благотворительном фонде Teach.",
    "Обязанности: планировать занятия, координировать преподавателей и вести расписание программ.",
    "Требования: опыт координации проектов и уверенная работа с таблицами.",
    "Условия: гибридный формат, частичная занятость и оплачиваемое оформление по договору.",
  ].join("\n");
  const noisySource = [
    "Главная | О фонде | Новости | Вакансии | Контакты",
    "Подписаться на новости",
    "Рекомендуемые материалы и другие вакансии",
    vacancy,
    "Откликнуться сейчас: https://example.com/apply",
    "Политика конфиденциальности | Пользовательское соглашение",
    "© 2026 Все права защищены",
  ].join("\n");
  const result = await runM6Fixture({
    row: { "Short Description": noisySource },
    eligibility_responses: [{
      ...ACCEPT_KEEP,
      editorial_mode: "MINIMAL",
      editorial_reason: "Remove employer-site chrome and application boilerplate.", material_gaps: [],
    }],
    editor_responses: { MINIMAL: [{ project_link_text: "Teach", draft_description: vacancy, facts_added: [] }] },
  });

  assert.equal(result.state.processing_status, "READY_FOR_PUBLISH");
  assert.equal(result.state.final_editorial_mode, "MINIMAL");
  assert.equal(result.state.final_description, linked(vacancy));
  assert.deepEqual(result.counters.validator_calls, ["MINIMAL"]);
  assert.deepEqual(plain(result.state.validation_history), [
    { attempt: 1, mode: "MINIMAL", decision: "PASS", issues: [] },
  ]);
});

test("ValidationResult post-validation enforces every invariant and the closed issue enum", async () => {
  const m5 = await runFixture({
    eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: "MINIMAL", editorial_reason: "Cleanup." }],
  });
  const initialized = await executeCode("Initialize MINIMAL Editorial", m5.state);
  const begun = await executeCode("Begin MINIMAL Attempt", initialized);
  const edited = await executeCode(
    "Validate MINIMAL EditedContent",
    responseWithText({ project_link_text: "Teach", draft_description: "Teach adults clearly.", facts_added: [] }),
    { "Begin MINIMAL Attempt": begun },
  );
  const checked = await executeCode("Deterministic MINIMAL Output Check", edited);
  assert.equal(checked.deterministic_result.decision, "PASS");

  const request = evaluateJsonBody("MINIMAL Validator", { "Deterministic MINIMAL Output Check": checked });
  assert.equal(request.model, CONFIG.validator_model);
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.text.format.name, "validation_result");
  assert.equal(request.text.format.strict, true);
  assert.deepEqual(request.text.format.schema.properties.issues.items.properties.type.enum, VALIDATOR_ISSUES);

  for (const issue of VALIDATOR_ISSUES) {
    const envelope = await executeCode(
      "Validate MINIMAL ValidationResult",
      responseWithText({ decision: "FAIL", issues: [{ type: issue, text: "Concrete text.", reason: "Concrete factual or contract reason." }] }),
      { "Deterministic MINIMAL Output Check": checked },
    );
    assert.equal(envelope.contract_valid, true, issue);
  }

  const invalid = [
    null,
    { decision: "PASS", issues: [], extra: true },
    { decision: "MAYBE", issues: [] },
    { decision: "PASS", issues: [{ type: "MEANING_LOST", text: "x", reason: "y" }] },
    { decision: "FAIL", issues: [] },
    { decision: "FAIL", issues: [{ type: "STYLE", text: "x", reason: "y" }] },
    { decision: "FAIL", issues: [{ type: "MEANING_LOST", text: "", reason: "y" }] },
    { decision: "FAIL", issues: [{ type: "MEANING_LOST", text: "x", reason: "" }] },
    { decision: "FAIL", issues: [{ type: "MEANING_LOST", text: "x", reason: "y", extra: true }] },
  ];
  for (const value of invalid) {
    const envelope = await executeCode(
      "Validate MINIMAL ValidationResult",
      responseWithText(value),
      { "Deterministic MINIMAL Output Check": checked },
    );
    assert.equal(envelope.contract_valid, false, JSON.stringify(value));
  }
});

test("editor and validator malformed contracts retry exactly once before ERROR", async () => {
  const eligibility = [{ ...ACCEPT_KEEP, editorial_mode: "MINIMAL", editorial_reason: "Cleanup." }];
  const correctedEditor = await runM6Fixture({
    eligibility_responses: eligibility,
    editor_responses: {
      MINIMAL: ["not-json", { project_link_text: "Teach", draft_description: "Teach adults.", facts_added: [] }],
    },
  });
  assert.deepEqual(correctedEditor.counters.editor_calls, ["MINIMAL", "MINIMAL"]);
  assert.equal(correctedEditor.state.processing_status, "READY_FOR_PUBLISH");
  const editorRetryPayload = JSON.parse(correctedEditor.counters.editor_inputs[1].body.input[1].content[0].text);
  assert.equal(editorRetryPayload.untrusted_source_data.short_description, "Teach adults.");
  assert.equal(editorRetryPayload.invalid_output, "not-json");
  assert.equal(typeof editorRetryPayload.contract_error, "string");

  const badEditor = await runM6Fixture({
    eligibility_responses: eligibility,
    editor_responses: { MINIMAL: ["bad-one", "bad-two", { project_link_text: "Teach", draft_description: "unused", facts_added: [] }] },
  });
  assert.deepEqual(badEditor.counters.editor_calls, ["MINIMAL", "MINIMAL"]);
  assert.deepEqual(badEditor.counters.validator_calls, []);
  assert.equal(badEditor.state.processing_status, "ERROR");
  assert.equal(badEditor.state.error_code, "MALFORMED_EDITED_CONTENT_OUTPUT");

  const correctedValidator = await runM6Fixture({
    eligibility_responses: eligibility,
    validator_responses: {
      MINIMAL: [{ decision: "PASS", issues: [{ type: "MEANING_LOST", text: "x", reason: "y" }] }, VALIDATION_PASS],
    },
  });
  assert.deepEqual(correctedValidator.counters.validator_calls, ["MINIMAL", "MINIMAL"]);
  assert.equal(correctedValidator.state.processing_status, "READY_FOR_PUBLISH");
  const validatorRetryPayload = JSON.parse(correctedValidator.counters.validator_inputs[1].body.input[1].content[0].text);
  assert.equal(validatorRetryPayload.untrusted_validation_data.short_description, "Teach adults.");
  assert.equal(typeof validatorRetryPayload.invalid_output, "string");
  assert.equal(typeof validatorRetryPayload.contract_error, "string");

  const badValidator = await runM6Fixture({
    eligibility_responses: eligibility,
    validator_responses: { MINIMAL: ["bad-one", "bad-two", VALIDATION_PASS] },
  });
  assert.deepEqual(badValidator.counters.validator_calls, ["MINIMAL", "MINIMAL"]);
  assert.equal(badValidator.state.processing_status, "ERROR");
  assert.equal(badValidator.state.error_code, "MALFORMED_VALIDATION_OUTPUT");
});

test("independent fallback chains restart from the original input and order telemetry", async () => {
  const original = "ORIGINAL_NORMALIZED_DESCRIPTION: Teach adults in live online groups and assess their progress.";
  const base = {
    row: { "Short Description": original },
    readable_sources: ["original_link"],
    worker_responses: { original_link: workerSuccess("Approved external responsibility.") },
    eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: "ENRICH", editorial_reason: "Responsibility is material." }],
    editor_responses: {
      ENRICH: [{
        project_link_text: "Teach", draft_description: "FAILED_ENRICH_DRAFT Teach: Approved external responsibility.",
        facts_added: [{ fact: "Responsibility.", source: "original_link", evidence: "Approved external responsibility." }],
      }],
      MINIMAL: [{ project_link_text: "Teach", draft_description: "FAILED_MINIMAL_DRAFT: Teach role teaches adult learners in live online groups.", facts_added: [] }],
    },
  };

  const enrichToMinimal = await runM6Fixture({
    ...base,
    editor_responses: {
      ...base.editor_responses,
      MINIMAL: [{ project_link_text: "Teach", draft_description: original, facts_added: [] }],
    },
    validator_responses: {
      ENRICH: [{ decision: "FAIL", issues: [{ type: "EXCESSIVE_REWRITE", text: "FAILED_ENRICH_DRAFT", reason: "The intervention exceeds ENRICH." }] }],
      MINIMAL: [VALIDATION_PASS],
    },
  });
  assert.equal(enrichToMinimal.state.processing_status, "READY_FOR_PUBLISH");
  assert.equal(enrichToMinimal.state.initial_editorial_mode, "ENRICH");
  assert.equal(enrichToMinimal.state.final_editorial_mode, "MINIMAL");
  assert.deepEqual(enrichToMinimal.counters.editor_calls, ["ENRICH", "MINIMAL"]);
  assert.deepEqual(plain(enrichToMinimal.state.validation_history), [
    { attempt: 1, mode: "ENRICH", decision: "FAIL", issues: ["EXCESSIVE_REWRITE"] },
    { attempt: 2, mode: "MINIMAL", decision: "PASS", issues: [] },
  ]);
  const fallbackMinimalInput = JSON.parse(enrichToMinimal.counters.editor_inputs[1].body.input[1].content[0].text);
  assert.deepEqual(plain(fallbackMinimalInput), {
    untrusted_source_data: { short_description: original },
    workflow_metadata: editorMetadata(original),
  });
  assert.doesNotMatch(JSON.stringify(fallbackMinimalInput), /FAILED_ENRICH_DRAFT|Approved external responsibility/);

  const allTheWayToKeep = await runM6Fixture({
    ...base,
    validator_responses: {
      ENRICH: [{ decision: "FAIL", issues: [{ type: "CONTRADICTION", text: "FAILED_ENRICH_DRAFT", reason: "Contradiction fixture." }] }],
      MINIMAL: [{ decision: "FAIL", issues: [{ type: "MEANING_LOST", text: "FAILED_MINIMAL_DRAFT", reason: "Original meaning was lost." }] }],
    },
  });
  assert.equal(allTheWayToKeep.state.processing_status, "READY_FOR_PUBLISH");
  assert.equal(allTheWayToKeep.state.initial_editorial_mode, "ENRICH");
  assert.equal(allTheWayToKeep.state.final_editorial_mode, "KEEP");
  assert.equal(allTheWayToKeep.state.final_description, linked(original));
  assert.deepEqual(allTheWayToKeep.counters.editor_calls, ["ENRICH", "MINIMAL"]);
  assert.deepEqual(allTheWayToKeep.counters.validator_calls, ["ENRICH", "MINIMAL"]);
  assert.equal(allTheWayToKeep.state.validation_attempts, 3);
  assert.deepEqual(plain(allTheWayToKeep.state.validation_history), [
    { attempt: 1, mode: "ENRICH", decision: "FAIL", issues: ["CONTRADICTION"] },
    { attempt: 2, mode: "MINIMAL", decision: "FAIL", issues: ["MEANING_LOST"] },
    { attempt: 3, mode: "KEEP", decision: "PASS", issues: [] },
  ]);
  assert.doesNotMatch(allTheWayToKeep.state.final_description, /FAILED_ENRICH_DRAFT|FAILED_MINIMAL_DRAFT/);

  const minimalToKeep = await runM6Fixture({
    row: { "Short Description": original },
    eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: "MINIMAL", editorial_reason: "Cleanup." }],
    editor_responses: { MINIMAL: [{ project_link_text: "Teach", draft_description: "FAILED_MINIMAL_DRAFT: Teach role teaches adult learners in live online groups.", facts_added: [] }] },
    validator_responses: {
      MINIMAL: [{ decision: "FAIL", issues: [{ type: "MEANING_LOST", text: "FAILED_MINIMAL_DRAFT", reason: "Original meaning was lost." }] }],
    },
  });
  assert.equal(minimalToKeep.state.initial_editorial_mode, "MINIMAL");
  assert.equal(minimalToKeep.state.final_editorial_mode, "KEEP");
  assert.equal(minimalToKeep.state.final_description, linked(original));
  assert.deepEqual(minimalToKeep.counters.editor_calls, ["MINIMAL"]);
  assert.deepEqual(plain(minimalToKeep.state.validation_history.map((entry) => entry.mode)), ["MINIMAL", "KEEP"]);
});

test("a successful first-pass ENRICH does not invoke any lower creative mode", async () => {
  const result = await runM6Fixture({
    readable_sources: ["original_link"],
    worker_responses: { original_link: workerSuccess("The role includes evening groups.") },
    eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: "ENRICH", editorial_reason: "Evening schedule is material." }],
    editor_responses: { ENRICH: [{
      project_link_text: "Teach", draft_description: "Teach adults in evening groups.",
      facts_added: [{ fact: "Evening groups.", source: "original_link", evidence: "evening groups" }],
    }] },
  });
  assert.deepEqual(result.counters.editor_calls, ["ENRICH"]);
  assert.deepEqual(result.counters.validator_calls, ["ENRICH"]);
  assert.equal(result.state.final_editorial_mode, "ENRICH");
  assert.deepEqual(plain(result.state.validation_history), [
    { attempt: 1, mode: "ENRICH", decision: "PASS", issues: [] },
  ]);
});

test("earlier terminal classes preserve outcomes while review and rejection may draft", async () => {
  const cases = [
    {
      label: "deterministic rejection",
      fixture: { row: { "Project Website Link": "not-a-url" } },
      status: "REJECTED",
    },
    {
      label: "malformed Original Link",
      fixture: { row: { "Original Link": "bad-original-link" } },
      status: "REJECTED",
    },
    {
      label: "unread link reviewed by the combined decision",
      fixture: {
        worker_responses: { original_link: workerFailure("EXTRACTION_FAILED") },
        eligibility_responses: [{ ...REVIEW_DECISION, review_reason: "Не удалось прочитать страницу вакансии." }],
      },
      status: "NEEDS_REVIEW",
    },
    {
      label: "context selector contract error",
      fixture: {
        readable_sources: ["original_link"],
        worker_responses: { original_link: workerSuccess("X".repeat(150)) },
        context_responses: { original_link: ["bad", "still-bad"] },
      },
      status: "ERROR",
    },
    {
      label: "eligibility rejection",
      fixture: {
        eligibility_responses: [{
          project_link_text: "Teach", role_title: null, employer_name: null, decision: "REJECT",
          primary_reason: "SALES",
          reasons: ["SALES"],
          evidence: [{ reason: "SALES", source: "short_description", text: "Sales targets." }],
          review_reason: null,
          editorial_mode: null,
          editorial_reason: null, material_gaps: [],
        }],
      },
      status: "REJECTED",
    },
    {
      label: "eligibility review",
      fixture: {
        eligibility_responses: [{
          project_link_text: "Teach", role_title: null, employer_name: null, decision: "NEEDS_REVIEW",
          primary_reason: null,
          reasons: [],
          evidence: [],
          review_reason: "Material source conflict.",
          editorial_mode: null,
          editorial_reason: null, material_gaps: [],
        }],
      },
      status: "NEEDS_REVIEW",
    },
    {
      label: "eligibility contract error",
      fixture: { eligibility_responses: ["bad", "still-bad"] },
      status: "ERROR",
    },
  ];
  for (const fixtureCase of cases) {
    const result = await runM6Fixture(fixtureCase.fixture);
    assert.equal(result.state.processing_status, fixtureCase.status, fixtureCase.label);
    assert.deepEqual(result.counters.editor_calls, fixtureCase.status === "ERROR" ? [] : ["ENRICH"], fixtureCase.label);
    assert.deepEqual(result.counters.validator_calls, fixtureCase.status === "ERROR" ? [] : ["ENRICH"], fixtureCase.label);
    assert.equal(result.counters.persistence_updates, 1, fixtureCase.label);
    assert.equal(result.update.processing_status, fixtureCase.status, fixtureCase.label);
    assert.equal(result.update.final_description, "", fixtureCase.label);
  }
});

test("terminal persistence updates exactly one selected row and never maps raw form columns", async () => {
  const result = await runM6Fixture({
    row: {
      Timestamp: "RAW_TIMESTAMP_SENTINEL",
      "Short Description": "Teach adults. RAW_DESCRIPTION_SENTINEL",
      "Project Website Link": "https://example.com/raw-project",
      "Original Link": "https://example.com/raw-vacancy",
      "Contact Info": "raw-contact@example.com",
    },
  });
  assert.deepEqual(plain(result.state.raw), result.rawBeforePersistence);
  assert.equal(result.update.row_number, CONFIG.selected_row_number);
  assert.equal(result.update.application_id, result.state.application_id);
  assert.match(result.update.processed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.update.workflow_version, CONFIG.workflow_version);
  assert.equal(result.update.config_version, CONFIG.config_version);
  // Section 17: the retired column stays in the Sheet and is written empty.
  assert.equal(result.update.source_requirement_json, "");
  assert.equal(result.update.reasons_json, JSON.stringify(result.state.reasons));
  assert.equal(result.update.eligibility_evidence_json, JSON.stringify(result.state.eligibility_evidence));
  assert.equal(result.update.facts_added_json, JSON.stringify(result.state.facts_added));
  assert.equal(result.update.validation_history_json, JSON.stringify(result.state.validation_history));
  assert.doesNotMatch(result.update.source_requirement_json, /\n|\s{2,}/);

  const rawColumns = ["Timestamp", "Short Description", "Project Website Link", "Original Link", "Contact Info"];
  for (const column of rawColumns) assert.equal(column in result.update, false);
  const persist = nodes.get("Persist Terminal State");
  assert.equal(persist.parameters.authentication, "serviceAccount");
  assert.equal(persist.parameters.operation, "update");
  assert.deepEqual(persist.parameters.columns.matchingColumns, ["row_number"]);
  assert.equal(persist.parameters.columns.mappingMode, "defineBelow");
  assert.deepEqual(Object.keys(persist.parameters.columns.value).sort(), Object.keys(result.update).sort());
  for (const column of rawColumns) assert.equal(column in persist.parameters.columns.value, false);
  assert.deepEqual(persist.credentials.googleApi, {
    id: TEST_CREDENTIAL_ENVIRONMENT.N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID,
    name: TEST_CREDENTIAL_ENVIRONMENT.N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_NAME,
  });
  assert.match(persist.parameters.documentId.value, /GOOGLE_SHEETS_DOCUMENT_ID/);
  assert.match(persist.parameters.sheetName.value, /GOOGLE_SHEETS_SHEET_NAME/);
});

test("terminal persistence rejects inconsistent status, final output, and telemetry state", async () => {
  const ready = await runM6Fixture({});
  await assert.rejects(
    () => executeCode("Prepare Terminal Persistence", { ...plain(ready.state), processing_status: "PROCESSING" }),
    /non-terminal/,
  );
  await assert.rejects(
    () => executeCode("Prepare Terminal Persistence", { ...plain(ready.state), final_description: null }),
    /fully validated final description/,
  );
  await assert.rejects(
    () => executeCode("Prepare Terminal Persistence", { ...plain(ready.state), validation_attempts: 2 }),
    /validation_attempts/,
  );
  const rejected = await runM6Fixture({ row: { "Project Website Link": "bad" } });
  await assert.rejects(
    () => executeCode("Prepare Terminal Persistence", { ...plain(rejected.state), final_description: "must not persist" }),
    /Only READY_FOR_PUBLISH/,
  );
});

test("M6 preserves all M3-M5 state while changing only editorial, telemetry, terminal, and error fields", async () => {
  const result = await runM6Fixture({
    readable_sources: ["original_link"],
    worker_responses: { original_link: workerSuccess("Approved context.") },
    eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: "ENRICH", editorial_reason: "Context is material." }],
    editor_responses: { ENRICH: [{
      project_link_text: "Teach", draft_description: "Teach adults. Approved context.",
      facts_added: [{ fact: "Approved context.", source: "original_link", evidence: "Approved context." }],
    }] },
  });
  for (const key of [
    "application_id", "raw", "normalized", "normalized_contact_info", "source_annotations", "duplicate",
    "sources", "eligibility_decision", "primary_reason", "reasons",
    "eligibility_evidence", "review_reason", "editorial_mode", "editorial_reason", "m4", "m5",
  ]) {
    assert.deepEqual(plain(result.state[key]), plain(result.m5State[key]), key);
  }
});

test("accepted editorial request failures map to terminal ERROR without fallback", async () => {
  const m5 = await runFixture({
    eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: "MINIMAL", editorial_reason: "Cleanup." }],
  });
  const initialized = await executeCode("Initialize MINIMAL Editorial", m5.state);
  const begun = await executeCode("Begin MINIMAL Attempt", initialized);
  const editorError = await executeCode(
    "MINIMAL Editor Integration Error",
    { message: "mock editor unavailable" },
    { "Begin MINIMAL Attempt": begun },
  );
  assert.equal(editorError.processing_status, "ERROR");
  assert.equal(editorError.error_code, "EDITOR_INTEGRATION_ERROR");
  assert.equal(editorError.validation_attempts, 0);

  const edited = await executeCode(
    "Validate MINIMAL EditedContent",
    responseWithText({ project_link_text: "Teach", draft_description: "Teach adults.", facts_added: [] }),
    { "Begin MINIMAL Attempt": begun },
  );
  const checked = await executeCode("Deterministic MINIMAL Output Check", edited);
  const validatorError = await executeCode(
    "MINIMAL Validator Integration Error",
    { message: "mock validator unavailable" },
    { "Deterministic MINIMAL Output Check": checked },
  );
  assert.equal(validatorError.processing_status, "ERROR");
  assert.equal(validatorError.error_code, "VALIDATOR_INTEGRATION_ERROR");
  assert.equal(validatorError.validation_attempts, 0);
});


test("accepted descriptions reuse one generation for draft and final, including deterministic KEEP", async () => {
  for (const mode of ["KEEP", "MINIMAL", "ENRICH"]) {
    const result = await runM6Fixture({
      eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: mode }],
      ...(mode === "ENRICH" ? {
        readable_sources: ["original_link"],
        worker_responses: { original_link: workerSuccess("Teach adults in evening groups.") },
      } : {}),
    });
    assert.equal(result.state.processing_status, "READY_FOR_PUBLISH");
    assert.ok(result.update.draft_description);
    assert.equal(result.update.draft_description, result.update.final_description);
    assert.deepEqual(result.counters.editor_calls, mode === "KEEP" ? [] : [mode]);
    assert.equal(result.state.m6.draft_only, undefined);
  }
});

test("review and rejection drafts preserve authoritative state, evidence, modes and sources", async () => {
  for (const decision of [REVIEW_DECISION, SALES_DECISION]) {
    const result = await runM6Fixture({
      row: { "Short Description": "Sell courses to adult learners." },
      eligibility_responses: [decision],
    });
    assert.equal(result.update.draft_description, "Sell courses to adult learners.");
    assert.equal(result.update.final_description, "");
    assert.equal(result.state.final_description, null);
    for (const key of ["processing_status", "eligibility_decision", "primary_reason", "reasons", "eligibility_evidence", "review_reason", "editorial_mode", "editorial_reason", "initial_editorial_mode", "final_editorial_mode", "sources", "source_annotations", "raw", "normalized", "duplicate", "validation_history", "validation_attempts"]) {
      assert.deepEqual(plain(result.state[key]), plain(result.m5State[key]), key);
    }
    assert.deepEqual(result.counters.editor_calls, ["ENRICH"]);
    assert.deepEqual(result.counters.validator_calls, ["ENRICH"]);
    assert.equal(result.update.initial_editorial_mode, "");
    assert.equal(result.update.final_editorial_mode, "");
    const body = result.counters.editor_inputs[0].body;
    assert.match(body.input[0].content[0].text, /REVIEWER COPY: this application will not be published automatically/);
    const input = JSON.parse(body.input[1].content[0].text);
    assert.equal(input.reviewer_diagnostics.review_reason, decision.review_reason);
    assert.deepEqual(input.untrusted_source_data.approved_external_context, {});
    assert.equal(result.counters.eligibility_calls, 1);
    assert.deepEqual(result.counters.worker_calls, ["original_link", "project_link"]);
  }
});

test("empty, title-only and unreliable material leaves optional drafts empty without changing outcomes", async () => {
  for (const text of ["", "Methodologist", "Home\nMenu\nPrivacy policy"]) {
    for (const fixture of [
      { eligibility_responses: [REVIEW_DECISION] },
      { row: { "Project Website Link": "bad" } },
      { worker_responses: { original_link: workerFailure("EXTRACTION_FAILED") }, eligibility_responses: [{ ...REVIEW_DECISION, review_reason: "Не удалось прочитать страницу вакансии." }] },
    ]) {
      const result = await runM6Fixture({ ...fixture, row: { ...fixture.row, "Short Description": text } });
      assert.ok(["NEEDS_REVIEW", "REJECTED"].includes(result.state.processing_status));
      assert.equal(result.state.draft_description, null);
      assert.equal(result.update.draft_description, "");
      assert.equal(result.update.final_description, "");
      assert.deepEqual(result.counters.editor_calls, []);
      assert.equal(result.state.review_reason, result.m5State.review_reason);
      assert.equal(result.state.primary_reason, result.m5State.primary_reason);
    }
  }
});

test("a reviewer draft may use existing relevant vacancy context but excludes wrong targets and unused sources", async () => {
  const fixture = {
    row: { "Short Description": "Methodologist" },
    readable_sources: ["original_link"],
    worker_responses: { original_link: workerSuccess("Teach adult learners in evening groups. Prepare lesson plans.") },
    eligibility_responses: [REVIEW_DECISION],
  };
  const result = await runM6Fixture(fixture);
  assert.ok(result.update.draft_description.includes("Prepare lesson plans"));
  assert.equal(result.update.final_description, "");
  assert.equal(result.update.original_link_context, result.m5State.sources.original_link.used_context);
  const validatorInput = JSON.parse(result.counters.validator_inputs[0].body.input[1].content[0].text);
  assert.equal(validatorInput.untrusted_validation_data.approved_external_context.original_link, result.update.original_link_context);
  assert.equal(validatorInput.untrusted_validation_data.editorial_mode, null);
  const disputed = await runM6Fixture({ ...fixture, eligibility_responses: [{
    ...SALES_DECISION, primary_reason: "WRONG_LINK_TARGET", reasons: ["WRONG_LINK_TARGET"],
    evidence: [{ reason: "WRONG_LINK_TARGET", source: "original_link", text: "Teach adult learners in evening groups." }],
  }] });
  assert.equal(disputed.state.primary_reason, "WRONG_LINK_TARGET");
  assert.equal(disputed.update.draft_description, "");
  assert.equal(disputed.update.original_link_context, result.update.original_link_context);
  assert.deepEqual(disputed.counters.editor_calls, []);

  for (const relation of ["WRONG_TARGET", "NO_USEFUL_CONTENT", null]) {
    const state = plain(result.m5State);
    state.sources.original_link.relation = relation;
    const prepared = await executeCode("Prepare Reviewer Draft", state);
    assert.equal(prepared.m6, undefined);
    assert.deepEqual(plain(prepared.sources), state.sources);
  }
  const employerOnly = plain(result.m5State);
  employerOnly.sources.project_link = employerOnly.sources.original_link;
  employerOnly.sources.original_link = { status: "not_requested" };
  assert.equal((await executeCode("Prepare Reviewer Draft", employerOnly)).m6, undefined);
});

test("draft failure or empty model output cannot change review or rejection routing", async () => {
  for (const decision of [REVIEW_DECISION, SALES_DECISION]) {
    for (const failure of [
      { editor_responses: { ENRICH: ["bad", "still-bad"] } },
      { editor_responses: { ENRICH: [{ project_link_text: "Teach", draft_description: "", facts_added: [] }] } },
      { editor_responses: { ENRICH: [{ project_link_text: "Teach", draft_description: "Home\nMenu\nPrivacy policy", facts_added: [] }] } },
      { editor_responses: { ENRICH: [{ project_link_text: "Teach", draft_description: "Teach adults via https://invented.example/job", facts_added: [] }] } },
      { validator_responses: { ENRICH: ["bad", "still-bad"] } },
      { validator_responses: { ENRICH: [{ decision: "FAIL", issues: [{ type: "UNSUPPORTED_FACT", text: "Unverified claim.", reason: "Not in source." }] }] } },
    ]) {
      const result = await runM6Fixture({ eligibility_responses: [decision], ...failure });
      assert.equal(result.state.processing_status, decision.decision === "REJECT" ? "REJECTED" : "NEEDS_REVIEW");
      assert.equal(result.state.review_reason, decision.review_reason);
      assert.equal(result.state.primary_reason, decision.primary_reason);
      assert.equal(result.state.error_code, null);
      // Section 15.1: without a usable factual candidate the submission is the working copy.
      assert.equal(result.update.draft_description, linked(VALID_ROW["Short Description"]));
      assert.equal(result.update.final_description, "");
      assert.equal(result.update.validation_attempts, 0);
      assert.deepEqual(result.counters.editor_calls.filter((mode) => mode !== "ENRICH"), []);
      assert.equal((await executeCode("Prepare Reviewer Draft", result.state)).m6.complete, true);
    }
    const m5 = await runFixture({ eligibility_responses: [decision] });
    const prepared = await executeCode("Prepare Reviewer Draft", m5.state);
    const begin = await executeCode("Begin ENRICH Attempt", prepared);
    for (const stage of ["Editor", "Validator"]) {
      const named = stage === "Editor" ? { "Begin ENRICH Attempt": begin } : { "Deterministic ENRICH Output Check": { state: begin } };
      const failed = await executeCode(`ENRICH ${stage} Integration Error`, { message: "fixture timeout" }, named);
      assert.equal(failed.processing_status, m5.state.processing_status);
      assert.equal(failed.review_reason, m5.state.review_reason);
      assert.equal(failed.primary_reason, m5.state.primary_reason);
      assert.equal(failed.error_code, null);
      assert.equal(failed.m6.complete, true);
    }
  }
});

test("duplicate short-circuit can draft without repeating eligibility or extraction", async () => {
  const result = await runM6Fixture({ rows: [
    { ...VALID_ROW, row_number: 2, application_id: "older-application" },
    { ...VALID_ROW, row_number: 3 },
  ], config: { selected_row_number: 3 } });
  assert.equal(result.state.primary_reason, "DUPLICATE_APPLICATION");
  assert.ok(result.update.draft_description);
  assert.equal(result.update.final_description, "");
  assert.equal(result.counters.eligibility_calls, 0);
  assert.deepEqual(result.counters.worker_calls, []);
});

test("draft contract retry preserves classification and reprocessing intentionally replaces generated outputs", async () => {
  const result = await runM6Fixture({
    eligibility_responses: [REVIEW_DECISION],
    editor_responses: { ENRICH: ["bad", { project_link_text: "Teach", draft_description: "Teach adults.", facts_added: [] }] },
  });
  assert.deepEqual(result.counters.editor_calls, ["ENRICH", "ENRICH"]);
  assert.equal(result.update.draft_description, linked("Teach adults."));
  assert.equal(result.update.final_description, "");
  assert.equal(result.state.review_reason, REVIEW_DECISION.review_reason);
  const oldRow = { ...VALID_ROW, application_id: "stable-id", project_link_text: "Teach", draft_description: "Previous draft", final_description: "Previous final" };
  const rerun = await runM6Fixture({ row: oldRow });
  assert.equal(rerun.update.application_id, "stable-id");
  assert.equal(rerun.update.draft_description, linked("Teach adults."));
  assert.equal(rerun.update.final_description, linked("Teach adults."));
  const deterministic = prepareApplication(oldRow);
  assert.equal(deterministic.draft_description, null);
  assert.equal(deterministic.final_description, null);
  await assert.rejects(() => executeCode("Prepare Terminal Persistence", { ...plain(result.state), project_link_text: "Teach", draft_description: { bad: true } }), /draft_description must be a string or null/);
  await assert.rejects(() => executeCode("Prepare Terminal Persistence", { ...plain(result.state), final_description: result.state.draft_description }), /Only READY_FOR_PUBLISH/);
});


test("disputed external context is retained for evidence but cannot enter a usable submitted-text draft", async () => {
  const result = await runM6Fixture({
    readable_sources: ["original_link"],
    worker_responses: { original_link: workerSuccess("WRONG_TARGET_SENTINEL: Manage warehouse shipments.") },
    eligibility_responses: [{ ...SALES_DECISION, primary_reason: "WRONG_LINK_TARGET", reasons: ["WRONG_LINK_TARGET"], evidence: [{ reason: "WRONG_LINK_TARGET", source: "original_link", text: "Manage warehouse shipments." }] }],
  });
  assert.equal(result.update.draft_description, linked("Teach adults."));
  assert.equal(result.update.final_description, "");
  assert.match(result.update.original_link_context, /WRONG_TARGET_SENTINEL/);
  assert.doesNotMatch(JSON.stringify(result.counters.editor_inputs), /WRONG_TARGET_SENTINEL/);
  assert.doesNotMatch(JSON.stringify(result.counters.validator_inputs), /WRONG_TARGET_SENTINEL/);
  assert.equal(result.state.primary_reason, "WRONG_LINK_TARGET");
});


const reusedUrlDuplicateCases = [
  {
    name: "same URL with different teacher roles is not a duplicate",
    current: { "Short Description": "Mathematics teacher. Teach children at our school." },
    duplicate: false,
  },
  {
    name: "same URL with the same teacher vacancy and project is a duplicate",
    current: {},
    duplicate: true,
  },
  {
    name: "same URL with case and whitespace equivalent vacancy text is a duplicate",
    current: { "Short Description": " ENGLISH   TEACHER.\nTeach children at our school. " },
    duplicate: true,
  },
  {
    name: "same URL and role without the same project is not a duplicate",
    current: { "Project Website Link": "https://other.example.org/school" },
    duplicate: false,
  },
  {
    name: "same URL and title with materially different vacancy details is not a duplicate",
    current: { "Short Description": "English teacher. Teach adults remotely." },
    duplicate: false,
  },
  {
    name: "same URL preserves first submission when a later row matches",
    current: { row_number: 4 },
    duplicate: false,
  },
  {
    name: "same URL rerun excludes the current application identity",
    current: { application_id: "earlier-english" },
    duplicate: false,
  },
];

for (const scenario of reusedUrlDuplicateCases) {
  test("embedded parity: " + scenario.name, async () => {
    // All shapes use the same rule, including unknown paths and query URLs.
    for (const url of [
      "https://ilischool.ru/laba#rec741116814",
      "https://example.org/opportunities#roles",
      "https://example.org/",
      "https://example.org/jobs/123?source=form#details",
    ]) {
      const earlier = {
        ...VALID_ROW,
        row_number: 5,
        application_id: "earlier-english",
        "Short Description": "English teacher. Teach children at our school.",
        "Project Website Link": "https://example.org/school#about",
        "Original Link": url,
      };
      const selected = {
        ...earlier,
        row_number: 6,
        application_id: "current-application",
        "Project Website Link": "https://example.org/school",
        "Original Link": url.split("#")[0],
        ...scenario.current,
      };
      const actual = await executeCode(
        "Prepare Selected Application", [earlier, selected], {},
        { ...CONFIG, selected_row_number: selected.row_number },
      );
      const expected = prepareApplication(selected, [earlier]);
      assert.deepEqual(JSON.parse(JSON.stringify(actual.duplicate)), expected.duplicate);
      assert.deepEqual(JSON.parse(JSON.stringify(actual.raw)), expected.raw);
      assert.deepEqual(JSON.parse(JSON.stringify(actual.normalized)), expected.normalized);
      assert.equal(actual.duplicate.is_duplicate, scenario.duplicate, url);
      assert.equal(actual.processing_status, scenario.duplicate ? "REJECTED" : "PROCESSING", url);
      if (scenario.duplicate) {
        assert.equal(actual.duplicate.match, "ORIGINAL_LINK", url);
        assert.equal(actual.duplicate.existing_application_id, "earlier-english", url);
      }
    }
  });
}

test("embedded parity: " + "careers and jobs retain exact secondary evidence and first submission wins", async () => {
  for (const path of ["careers", "jobs"]) {
    for (const variant of ["different-role", "same-role", "different-project", "later-row"]) {
      const earlier = {
        ...VALID_ROW,
        row_number: 5,
        application_id: "earlier-english",
        "Short Description": "English teacher.",
        "Original Link": `https://example.org/${path}#roles`,
      };
      const selected = {
        ...earlier,
        row_number: variant === "later-row" ? 4 : 6,
        application_id: "current-application",
        "Original Link": `https://example.org/${path}`,
        "Short Description": variant === "different-role" ? "Mathematics teacher." : "English teacher.",
        "Project Website Link": variant === "different-project" ? "https://other.example.org/school" : earlier["Project Website Link"],
      };
      const actual = await executeCode(
        "Prepare Selected Application", [earlier, selected], {},
        { ...CONFIG, selected_row_number: selected.row_number },
      );
      const expected = prepareApplication(selected, [earlier]);
      assert.deepEqual(JSON.parse(JSON.stringify(actual.duplicate)), expected.duplicate);
      assert.deepEqual(JSON.parse(JSON.stringify(actual.raw)), expected.raw);
      assert.deepEqual(JSON.parse(JSON.stringify(actual.normalized)), expected.normalized);
      assert.equal(actual.duplicate.is_duplicate, variant === "same-role", `${path}: ${variant}`);
      if (variant === "same-role") {
        assert.equal(actual.duplicate.match, "PROJECT_LINK_AND_SHORT_DESCRIPTION");
      }
    }
  }
});

test("embedded parity: " + "reused URL scans past other roles and keeps the original submission on rerun", async () => {
  const english = { ...VALID_ROW, row_number: 5, application_id: "first-english",
    "Short Description": "English teacher.", "Original Link": "https://example.org/laba#english" };
  const mathematics = { ...english, row_number: 6, application_id: "first-mathematics",
    "Short Description": "Mathematics teacher.", "Original Link": "https://example.org/laba#mathematics" };
  const repeated = { ...english, row_number: 7, application_id: "repeated-english" };
  const rows = [mathematics, repeated, english];
  for (const selected of [english, mathematics, repeated]) {
    const actual = await executeCode(
      "Prepare Selected Application", rows, {},
      { ...CONFIG, selected_row_number: selected.row_number },
    );
    assert.deepEqual(JSON.parse(JSON.stringify(actual.duplicate)), prepareApplication(selected, rows).duplicate);
    assert.equal(actual.duplicate.is_duplicate, selected === repeated);
    if (selected === repeated) assert.equal(actual.duplicate.existing_application_id, "first-english");
  }
});

// Defect-class fixtures: deliberately independent of Sheet row numbers and source format.
const REVIEWER_SHORT = "Ищем специалиста отдела приема в РЭШ";
const REVIEWER_VACANCY = [
  "Специалист отдела приема в РЭШ",
  "Обязанности: сопровождать абитуриентов, организовывать вступительные испытания и готовить документы приемной комиссии.",
  "Требования: опыт в образовательных проектах, грамотная письменная речь и уверенная работа с таблицами.",
  "Условия: полная занятость, гибридный формат работы и оформление по трудовому договору.",
  "Оплата: оклад 90000 рублей, медицинская страховка после испытательного срока.",
].join("\n");
const REVIEWER_PROJECT = "РЭШ — образовательная организация. Команда развивает программы экономики и проводит исследования.";

function reviewerRecoveryFixture(overrides = {}) {
  return {
    row: { "Short Description": REVIEWER_SHORT },
    config: { max_llm_source_chars: 900 },
    readable_sources: ["original_link"],
    worker_responses: { original_link: workerSuccess(REVIEWER_VACANCY) },
    eligibility_responses: [{ ...ACCEPT_KEEP, project_link_text: "РЭШ" }],
    ...overrides,
  };
}

async function forcedKeepRecoveryState(fixture = {}) {
  const { state: classified } = await runFixture(reviewerRecoveryFixture(fixture));
  // Simulate an upstream mistake reaching KEEP despite the independent mode-selection guard.
  const state = plain(classified);
  state.editorial_mode = "KEEP";
  state.m5.route = "ACCEPT_KEEP";
  const initialized = await executeCode("Initialize KEEP Editorial", state);
  const candidate = await executeCode("Execute Deterministic KEEP", initialized);
  return executeCode("Validate Deterministic KEEP", candidate);
}

function assertRecoveredReview(update, state, expected) {
  assert.equal(update.draft_description, expected);
  assert.equal(update.final_description, "");
  assert.equal(update.processing_status, state.processing_status);
  assert.equal(update.eligibility_decision, state.eligibility_decision ?? "");
  assert.equal(update.review_reason, state.review_reason ?? "");
  assert.equal(update.primary_reason, state.primary_reason ?? "");
  assert.deepEqual(JSON.parse(update.reasons_json), plain(state.reasons));
  assert.deepEqual(JSON.parse(update.eligibility_evidence_json), plain(state.eligibility_evidence));
  assert.deepEqual(JSON.parse(update.validation_history_json), plain(state.validation_history));
  assert.equal(update.validation_attempts, state.validation_attempts);
  assert.equal(update.final_editorial_mode, "");
  assert.equal(update.facts_added_json, "[]");
}

test("reviewer recovery leaves a valid KEEP candidate byte-for-byte unchanged even with rich context", async () => {
  const result = await runM6Fixture(reviewerRecoveryFixture({ row: { "Short Description": REVIEWER_VACANCY } }));
  assert.equal(result.state.editorial_mode, "KEEP");
  assert.equal(result.update.draft_description, linked(REVIEWER_VACANCY, "РЭШ"));
  assert.equal(result.update.final_description, linked(REVIEWER_VACANCY, "РЭШ"));
  assert.deepEqual(result.counters.editor_calls, []);
  assert.equal(result.state.validation_history.at(-1).decision, "PASS");
});

test("a bare role-and-employer announcement routes mistaken KEEP and MINIMAL decisions to ENRICH (Section 13.10)", async () => {
  for (const [short, context] of [
    [REVIEWER_SHORT, REVIEWER_VACANCY],
    ["Learnly needs a teacher.", "Teacher at Learnly, an online school.\nResponsibilities: teach adults in live groups and prepare lesson plans for weekly classes.\nRequirements: teaching experience and excellent communication skills.\nConditions: remote work, full-time employment and a flexible schedule.\nSalary: 5000 per month."],
  ]) {
    for (const mode of ["KEEP", "MINIMAL"]) {
      const result = await runM6Fixture(reviewerRecoveryFixture({
        row: { "Short Description": short },
        worker_responses: { original_link: workerSuccess(context) },
        eligibility_responses: [{ ...ACCEPT_KEEP, project_link_text: short.includes("РЭШ") ? "РЭШ" : "Learnly", editorial_mode: mode }],
      }));
      assert.equal(result.state.editorial_mode, "ENRICH");
      assert.equal(result.state.initial_editorial_mode, "ENRICH");
      assert.equal(result.state.final_editorial_mode, "ENRICH");
      assert.deepEqual(result.counters.editor_calls, ["ENRICH"]);
      assert.equal(result.counters.eligibility_calls, 1);
      assert.ok(result.update.draft_description.includes(context));
    }
  }
});

test("eligibility initial and retry prompts judge sufficiency from the submission and the details link (Section 13.0.2)", () => {
  for (const name of ["Eligibility Decision", "Eligibility Contract Retry"]) {
    const body = nodes.get(name).parameters.jsonBody;
    assert.match(body, /published as the post's details link/, name);
    assert.match(body, /names the hiring organization or project .*states the role, and briefly conveys what the work involves/, name);
    assert.match(body, /list each sufficiency element that the Short Description lacks and a readable link supplies — EMPLOYER \(who is hiring\), ROLE, WORK \(what the work involves\)/, name);
    // Publication post amendment: ENRICH also fills optional post elements, never page volume.
    assert.match(body, /ENRICH: a readable link states a post element the submission lacks/, name);
    assert.match(body, /Page information outside the post elements is never a reason for ENRICH/, name);
    assert.match(body, /what applies to the whole submitted vacancy; general marketing text and details of other vacancies do not count/, name);
  }
  assert.match(nodes.get("ENRICH Editor").parameters.jsonBody, /is left to the details link that is published with every post/);
  assert.match(nodes.get("ENRICH Validator").parameters.jsonBody, /Never report omitted secondary duties, further requirements, experience, education, benefits or other details/);
});

test("forced KEEP meaning loss keeps the submission as the reviewer working copy, never a page dump (Section 15.1)", async () => {
  const state = await forcedKeepRecoveryState();
  assert.equal(state.sources.original_link.status, "success");
  assert.equal(state.sources.original_link.relation, "RELEVANT");
  assert.equal(state.sources.original_link.used_context, REVIEWER_VACANCY);
  assert.equal(state.processing_status, "NEEDS_REVIEW");
  assert.deepEqual(plain(state.validation_history.at(-1).issues), ["MEANING_LOST"]);
  const gated = await executeCode("Prepare Reviewer Draft", state);
  assert.deepEqual(plain(gated), plain(state));
  const snapshot = plain(state);
  const update = await executeCode("Prepare Terminal Persistence", gated);
  assertRecoveredReview(update, state, linked(REVIEWER_SHORT, "РЭШ"));
  assert.equal(update.project_link_text, "РЭШ");
  assert.doesNotMatch(update.draft_description, /Обязанности: сопровождать/);
  assert.deepEqual(plain(state), snapshot);
});

test("candidates that never reached the semantic validator are not retained; the submission is the working copy", async () => {
  const result = await runM6Fixture(reviewerRecoveryFixture({
    eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: "ENRICH" }],
    editor_responses: {
      ENRICH: [{ project_link_text: "Teach", draft_description: REVIEWER_SHORT, facts_added: [] }],
      MINIMAL: [{ project_link_text: "Teach", draft_description: REVIEWER_SHORT, facts_added: [] }],
    },
  }));
  assert.deepEqual(result.counters.editor_calls, ["ENRICH", "MINIMAL"]);
  assert.deepEqual(result.counters.validator_calls, []);
  assert.deepEqual(plain(result.state.validation_history.map((entry) => entry.mode)), ["ENRICH", "MINIMAL", "KEEP"]);
  assert.ok(result.state.validation_history.every((entry) => entry.issues.includes("MEANING_LOST")));
  assertRecoveredReview(result.update, result.state, REVIEWER_SHORT);
});

const RECOVERY_DUTIES = "сопровождать абитуриентов, организовывать вступительные испытания и готовить документы приемной комиссии";
const RECOVERY_CANDIDATE = `${REVIEWER_SHORT}. Задачи: ${RECOVERY_DUTIES}.`;

async function recoveryCandidateRun(issue) {
  return runM6Fixture(reviewerRecoveryFixture({
    eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: "ENRICH", project_link_text: "РЭШ" }],
    editor_responses: {
      ENRICH: [{ project_link_text: "РЭШ", draft_description: RECOVERY_CANDIDATE,
        facts_added: [{ fact: "Задачи специалиста", source: "original_link", evidence: RECOVERY_DUTIES }] }],
      MINIMAL: [{ project_link_text: "РЭШ", draft_description: REVIEWER_SHORT, facts_added: [] }],
    },
    validator_responses: { ENRICH: [{ decision: "FAIL", issues: [issue] }] },
  }));
}

test("the latest semantically validated candidate without a factual issue is the reviewer working copy", async () => {
  const issue = (type, text) => ({ type, text, reason: "Fixture issue." });
  for (const [label, candidateIssue, expected, selection] of [
    ["content loss", issue("MEANING_LOST", "Условия"), linked(RECOVERY_CANDIDATE, "РЭШ"), "РЭШ"],
    ["excluded material", issue("OTHER_CONTRACT_VIOLATION", "excluded_material"), linked(RECOVERY_CANDIDATE, "РЭШ"), "РЭШ"],
    // The validator no longer judges the link selection; any other contract issue may hide an unrecorded claim.
    ["unknown contract issue", issue("OTHER_CONTRACT_VIOLATION", "project_link_text"), linked(REVIEWER_SHORT, "РЭШ"), "РЭШ"],
    ["excessive rewrite", issue("EXCESSIVE_REWRITE", "Задачи"), linked(RECOVERY_CANDIDATE, "РЭШ"), "РЭШ"],
    ["unsupported fact", issue("UNSUPPORTED_FACT", "Задачи"), linked(REVIEWER_SHORT, "РЭШ"), "РЭШ"],
    ["invented number", issue("INVENTED_NUMBER_OR_DATE", "Задачи"), linked(REVIEWER_SHORT, "РЭШ"), "РЭШ"],
    ["unrecorded external claim", issue("OTHER_CONTRACT_VIOLATION", "Задачи"), linked(REVIEWER_SHORT, "РЭШ"), "РЭШ"],
    ["contradiction", issue("CONTRADICTION", "Другая вакансия"), linked(REVIEWER_SHORT, "РЭШ"), "РЭШ"],
  ]) {
    const result = await recoveryCandidateRun(candidateIssue);
    assert.deepEqual(result.counters.validator_calls, ["ENRICH"], label);
    assert.equal(result.update.processing_status, "NEEDS_REVIEW", label);
    assert.equal(result.update.final_description, "", label);
    assert.equal(result.update.draft_description, expected, label);
    assert.equal(result.update.project_link_text, selection, label);
    // Telemetry keeps every attempt; the working copy never changes it.
    assert.deepEqual(plain(result.state.validation_history.map((entry) => entry.mode)), ["ENRICH", "MINIMAL", "KEEP"], label);
  }
});

test("the reviewer working copy never appends page context or raw parser data", async () => {
  const state = await forcedKeepRecoveryState({
    config: { max_llm_source_chars: 100 },
    worker_responses: { original_link: workerSuccess(REVIEWER_VACANCY + "\nUNSELECTED_RAW_SENTINEL") },
    context_responses: { original_link: [{ selected_context: REVIEWER_VACANCY, relation: "RELEVANT", reason: null }] },
  });
  state.sources.project_link = { ...state.sources.original_link, used_context: REVIEWER_PROJECT };
  state.sources.original_link.raw_html = "<script>RAW_HTML_SENTINEL</script>";
  const update = await executeCode("Prepare Terminal Persistence", state);
  assertRecoveredReview(update, state, linked(REVIEWER_SHORT, "РЭШ"));
  assert.doesNotMatch(update.draft_description, /SENTINEL|Обязанности|образовательная организация/);
  assert.equal(update.original_link_context, REVIEWER_VACANCY);
});

for (const condition of ["extraction_failed", "broken", "not_requested", "WRONG_TARGET", "NO_USEFUL_CONTENT", "unrelated", "disputed", "empty", "unselected"]) {
  test(`reviewer working copy never includes ${condition} source content`, async () => {
    const state = await forcedKeepRecoveryState();
    const source = state.sources.original_link;
    if (["extraction_failed", "broken", "not_requested"].includes(condition)) source.status = condition;
    if (["WRONG_TARGET", "NO_USEFUL_CONTENT"].includes(condition)) source.relation = condition;
    if (condition === "unrelated") source.relation = null;
    if (condition === "empty") source.used_context = " \n ";
    if (condition === "disputed") state.eligibility_evidence = [{ source: "original_link", reason: "WRONG_LINK_TARGET", text: "Wrong vacancy." }];
    if (condition === "unselected") {
      state.m6.draft_only = true;
      state.m6.draft_context = {};
      state.m6.reviewer_validation = { decision: "FAIL", issues: ["MEANING_LOST"] };
    }
    const update = await executeCode("Prepare Terminal Persistence", state);
    assertRecoveredReview(update, state, state.draft_description);
  });
}

test("manual-review and rejected drafts without a usable candidate keep the submission without retrying the LLM", async () => {
  for (const decision of [REVIEW_DECISION, SALES_DECISION]) {
    for (const candidate of [REVIEWER_SHORT, "", "Home\nMenu\nPrivacy policy"]) {
      const result = await runM6Fixture(reviewerRecoveryFixture({
        eligibility_responses: [decision],
        editor_responses: { ENRICH: [{ project_link_text: "Teach", draft_description: candidate, facts_added: [] }] },
      }));
      assert.deepEqual(result.counters.editor_calls, ["ENRICH"]);
      assert.deepEqual(result.counters.validator_calls, []);
      assert.equal(result.state.eligibility_decision, decision.decision);
      assert.deepEqual(plain(result.state.validation_history), []);
      assert.equal(result.state.editorial_mode, null);
      assertRecoveredReview(result.update, result.state, REVIEWER_SHORT);
    }
  }
});

test("a passed reviewer candidate stays unchanged; a factually failed one gives way to the submission", async () => {
  const passed = await runM6Fixture(reviewerRecoveryFixture({ eligibility_responses: [REVIEW_DECISION] }));
  assert.equal(passed.update.draft_description, passed.state.draft_description);
  assert.deepEqual(passed.counters.editor_calls, ["ENRICH"]);
  const failed = await runM6Fixture(reviewerRecoveryFixture({
    eligibility_responses: [REVIEW_DECISION],
    validator_responses: { ENRICH: [{ decision: "FAIL", issues: [{ type: "UNSUPPORTED_FACT", text: "Unsupported candidate claim", reason: "No source support." }] }] },
  }));
  assert.equal(failed.update.draft_description, REVIEWER_SHORT);
  assert.equal(failed.update.final_description, "");
  assert.deepEqual(failed.counters.editor_calls, ["ENRICH"]);
});

test("project context alone cannot recover a title-only vacancy body", async () => {
  const state = await forcedKeepRecoveryState({ row: { "Short Description": "Methodologist" } });
  state.sources.project_link = state.sources.original_link;
  state.sources.original_link = { status: "extraction_failed" };
  state.source_requirement = { original_link_required: true, project_link_required: true };
  const update = await executeCode("Prepare Terminal Persistence", state);
  assert.equal(update.draft_description, "");
  assert.equal(update.final_description, "");
});

test("project context alone never forces ENRICH, and a bare announcement still cannot publish through KEEP", async () => {
  const result = await runM6Fixture(reviewerRecoveryFixture({
    readable_sources: ["project_link"],
    worker_responses: { project_link: workerSuccess(REVIEWER_VACANCY) },
  }));
  assert.equal(result.state.initial_editorial_mode, "KEEP");
  assert.deepEqual(result.counters.editor_calls, []);
  // The non-required Original Link is fetched but unreadable in this fixture.
  assert.equal(result.state.sources.original_link.status, "extraction_failed");
  assert.deepEqual(plain(result.state.validation_history), [{ attempt: 1, mode: "KEEP", decision: "FAIL", issues: ["MEANING_LOST"] }]);
  assert.equal(result.update.processing_status, "NEEDS_REVIEW");
  assert.equal(result.update.final_description, "");
});

test("mode protection ignores unapproved content and mere volume without material vacancy information", async () => {
  const base = (await runFixture(reviewerRecoveryFixture())).state;
  // A non-required but successfully read page is approved context (Stage 3).
  for (const condition of ["failed", "irrelevant", "disputed", "noise"]) {
    const state = plain(base);
    if (condition === "failed") state.sources.original_link.status = "extraction_failed";
    if (condition === "irrelevant") state.sources.original_link.relation = "NO_USEFUL_CONTENT";
    if (condition === "noise") state.sources.original_link.used_context = "Home\nMenu\nPrivacy policy\n".repeat(100);
    const decision = { ...ACCEPT_KEEP, evidence: condition === "disputed" ? [{ reason: "WRONG_LINK_TARGET", source: "original_link", text: "Wrong target." }] : [] };
    const applied = await executeCode("Apply Eligibility Decision", { state, decision });
    assert.equal(applied.editorial_mode, "KEEP", condition);
  }
});

const PUBLICATION_SOURCE = "Simulative ищет продуктового маркетолога вебинарной воронки. Нужно разрабатывать вебинары и анализировать конверсию. Требуется опыт маркетинга образовательных продуктов. Работа удалённая, полная занятость.";
const PUBLICATION_IDENTITY = { role_title: "Продуктовый маркетолог вебинарной воронки", employer_name: "Simulative" };

test("existing semantic decision extracts supported identity for KEEP and AI modes without extra calls", async () => {
  for (const mode of ["KEEP", "MINIMAL", "ENRICH"]) {
    const result = await runM6Fixture({
      row: { "Short Description": PUBLICATION_SOURCE },
      eligibility_responses: [{ ...ACCEPT_KEEP, ...PUBLICATION_IDENTITY, project_link_text: "Simulative", editorial_mode: mode }],
      ...(mode === "ENRICH" ? {
        readable_sources: ["original_link"],
        worker_responses: { original_link: workerSuccess("Опыт от двух лет.") },
      } : {}),
    });
    assert.equal(result.update.processing_status, "READY_FOR_PUBLISH");
    for (const [field, value] of Object.entries(PUBLICATION_IDENTITY)) assert.equal(result.update[field], value);
    assert.equal(result.counters.eligibility_calls, 1);
    assert.deepEqual(result.counters.editor_calls, mode === "KEEP" ? [] : [mode]);
    const prompt = result.counters.eligibility_inputs[0].input[0].content[0].text;
    assert.match(prompt, /role_title and employer_name are the most precise concise names supported by the Short Description and the readable, relevant links/);
    assert.match(prompt, /never infer them from URLs, contacts or outside knowledge; null when unsure/);
  }
});

test("nullable identity leaves every terminal status unchanged and clears stale Sheet identities on rerun", async () => {
  for (const fixture of [{}, { eligibility_responses: [REVIEW_DECISION] }, { eligibility_responses: [SALES_DECISION] }, { eligibility_responses: ["broken"] }]) {
    const result = await runM6Fixture({ ...fixture, row: { role_title: "old role", employer_name: "old employer" } });
    for (const field of Object.keys(PUBLICATION_IDENTITY)) {
      assert.equal(result.state[field], null);
      assert.equal(result.update[field], "");
    }
    const expected = !fixture.eligibility_responses ? "READY_FOR_PUBLISH"
      : fixture.eligibility_responses[0] === REVIEW_DECISION ? "NEEDS_REVIEW"
        : fixture.eligibility_responses[0] === SALES_DECISION ? "REJECTED" : "ERROR";
    assert.equal(result.update.processing_status, expected);
  }
  const early = await runM6Fixture({ row: { "Short Description": "", "Project Website Link": "bad" } });
  assert.equal(early.update.role_title, "");
  assert.equal(early.update.employer_name, "");
  assert.equal(early.update.processing_status, "REJECTED");
  assert.equal(early.counters.eligibility_calls, 0);
  assert.deepEqual(early.counters.editor_calls, []);
});

test("identity extraction uses approved source context without leaking metadata into MINIMAL editorial input", async () => {
  const result = await runM6Fixture({
    row: { "Short Description": "Teach adults." },
    readable_sources: ["project_link"],
    worker_responses: { project_link: workerSuccess("Simulative is an educational organization.") },
    eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: "MINIMAL", role_title: "Teacher", employer_name: "Simulative" }],
  });
  assert.equal(result.update.employer_name, "Simulative");
  const sources = JSON.parse(result.counters.eligibility_inputs[0].input[1].content[0].text).untrusted_case_data.evidence_sources;
  assert.match(sources.project_link.content, /Simulative/);
  assert.equal(sources.project_link.status, "success");
  const editorInput = JSON.parse(result.counters.editor_inputs[0].body.input[1].content[0].text).untrusted_source_data;
  assert.deepEqual(editorInput, { short_description: "Teach adults." });
});

test("identity schema is strict, nullable, and covered by the existing contract retry", async () => {
  const { state } = await runFixture({ stop_before_eligibility: true });
  const body = evaluateJsonBody("Eligibility Decision", { "M4 Source Acquisition Complete": state });
  for (const field of Object.keys(PUBLICATION_IDENTITY)) {
    assert.deepEqual(body.text.format.schema.properties[field].type, ["string", "null"]);
    assert.ok(body.text.format.schema.required.includes(field));
    for (const value of [undefined, 7, {}]) {
      const bad = { ...ACCEPT_KEEP, [field]: value };
      const checked = await executeCode("Validate Eligibility Decision", responseWithText(bad), { "M4 Source Acquisition Complete": state });
      assert.equal(checked.contract_valid, false);
    }
  }
  const result = await runM6Fixture({ eligibility_responses: [{ ...ACCEPT_KEEP, employer_name: 7 }, ACCEPT_KEEP] });
  assert.equal(result.counters.eligibility_calls, 2);
  assert.equal(result.update.processing_status, "READY_FOR_PUBLISH");
});

test("early reviewer editor extracts identity with its existing call and validator checks it", async () => {
  const result = await runM6Fixture({
    row: { "Short Description": PUBLICATION_SOURCE, "Contact Info": "@examplebot" },
    editor_responses: { ENRICH: [{ project_link_text: "Simulative", draft_description: `🔥 ${PUBLICATION_SOURCE}`, facts_added: [], ...PUBLICATION_IDENTITY }] },
  });
  assert.equal(result.update.processing_status, "REJECTED");
  assert.equal(result.update.primary_reason, "TELEGRAM_BOT_CONTACT");
  assert.equal(result.update.final_description, "");
  assert.equal(result.update.draft_description, linked(PUBLICATION_SOURCE, "Simulative"));
  assert.equal(result.update.employer_name, "Simulative");
  assert.equal(result.counters.eligibility_calls, 0);
  assert.deepEqual(result.counters.editor_calls, ["ENRICH"]);
  assert.deepEqual(result.counters.validator_calls, ["ENRICH"]);
  const request = result.counters.editor_inputs[0].body;
  assert.ok(request.text.format.schema.required.includes("role_title"));
  const validation = JSON.parse(result.counters.validator_inputs[0].body.input[1].content[0].text).untrusted_validation_data;
  assert.equal(validation.employer_name, "Simulative");
});

test("AI prompts request the post shape, exclusions and soft budget, with deterministic emoji enforcement", async () => {
  for (const mode of ["MINIMAL", "ENRICH"]) {
    const added = "Опыт от двух лет.";
    const result = await runM6Fixture({
      row: { "Short Description": PUBLICATION_SOURCE.replace("Simulative ищет продуктового маркетолога вебинарной воронки.", "Продуктовый маркетолог вебинарной воронки — Simulative.") },
      eligibility_responses: [{ ...ACCEPT_KEEP, ...PUBLICATION_IDENTITY, project_link_text: "Simulative", editorial_mode: mode }],
      ...(mode === "ENRICH" ? {
        readable_sources: ["original_link"],
        worker_responses: { original_link: workerSuccess(added) },
      } : {}),
      editor_responses: { [mode]: [{
        project_link_text: "Simulative", draft_description: `🔥 ${PUBLICATION_SOURCE}${mode === "ENRICH" ? `\n📌 ${added}` : ""} ✅`,
        facts_added: mode === "ENRICH" ? [{ fact: added, source: "original_link", evidence: added }] : [],
      }] },
    });
    assert.equal(result.update.processing_status, "READY_FOR_PUBLISH");
    assert.match(result.update.final_description, /^\[Simulative\]\(https:\/\/example.com\/project\) ищет продуктового маркетолога/);
    assert.equal(result.update.draft_description, result.update.final_description);
    assert.doesNotMatch(result.update.final_description, /\p{Extended_Pictographic}/u);
    const prompt = result.counters.editor_inputs[0].body.input[0].content[0].text;
    assert.match(prompt, /\(1\) an opening that says who is hiring whom/);
    assert.match(prompt, /no emoji/);
    assert.match(prompt, /A post contains, in this order.*Opening:.*Excluded material never belongs in a post.*Length: aim for at most workflow_metadata\.target_visible_chars visible characters/s);
    assert.match(prompt, /the Short Description has workflow_metadata\.short_description_visible_chars/);
    assert.doesNotMatch(prompt, /350|450|600|765|900/);
    const payload = JSON.parse(result.counters.editor_inputs[0].body.input[1].content[0].text);
    // Spec Section 13.0.1: the editorial target is 85% of the maximum (765 for 900).
    const submission = JSON.parse(result.counters.editor_inputs[0].body.input[1].content[0].text).untrusted_source_data.short_description;
    assert.deepEqual(payload.workflow_metadata, { ...editorMetadata(submission), ...(mode === "ENRICH" ? { material_gaps: [] } : {}) });
    assert.equal(payload.workflow_metadata.target_visible_chars, 765);
    // Section 14.1: the validator judges the editor's body without the code-created link.
    const validated = JSON.parse(result.counters.validator_inputs[0].body.input[1].content[0].text).untrusted_validation_data;
    assert.equal(validated.draft_description, result.update.final_description.replace("[Simulative](https://example.com/project)", "Simulative"));
  }
});

test("openings keep the author's wording and follow no fixed formula; evaluations yield to concrete page values", () => {
  const body = (name) => nodes.get(name).parameters.jsonBody;
  for (const name of ["MINIMAL Editor", "ENRICH Editor", "MINIMAL Editor Contract Retry", "ENRICH Editor Contract Retry"]) {
    assert.match(body(name), /keep the author's opening when it already says who is hiring whom .*correcting only errors/, name);
    // Execution 498–509 review: rows 9/10 prepended the employer, row 12 repeated its title line.
    assert.match(body(name), /fit the name into the sentence in natural grammar and keep the author's word order, for example «Мы в X приглашаем…», «Команда X приглашает…», «Ищем методиста в X…»/, name);
    assert.match(body(name), /followed by the author's own opening sentence is a heading: keep the sentence and drop the title/, name);
    assert.match(body(name), /without a fixed formula, for example «В X открыта вакансия методиста…», «X нужен методист…», «X приглашает преподавателя…»/, name);
  }
  assert.match(body("ENRICH Editor"), /an evaluative phrase without concrete content \(«комфортный график», «достойная зарплата», «удобный формат»\) does not state an aspect, so a concrete page value replaces it/);
  for (const name of ["MINIMAL Validator", "ENRICH Validator"]) {
    assert.match(body(name), /An evaluative phrase without concrete content \(«комфортный график»\) states no aspect, so replacing it with a concrete page value is correct/, name);
    assert.match(body(name), /never fail a draft for wording, block order, structure, headings, its opening or its length/, name);
  }
  // Each role receives only its own rules: opening grammar belongs to the editors.
  for (const name of ["Eligibility Decision", "Eligibility Contract Retry", "MINIMAL Validator", "ENRICH Validator"]) {
    assert.doesNotMatch(body(name), /Мы в X приглашаем|Ищем методиста в X/, name);
  }
  // The single model opening that every post copied is gone (execution 486–497 review).
  for (const name of ["Eligibility Decision", "MINIMAL Editor", "ENRICH Editor", "MINIMAL Validator", "ENRICH Validator"]) {
    assert.doesNotMatch(body(name), /Университет X ищет|Школа X ищет/, name);
  }
});

test("KEEP and terminal projection sanitize every description while preserving raw input and status", async () => {
  const raw = "Teach🔥adults. — «Курсы»\n• [Details](https://example.com/a?x=1#part) ✅";
  const result = await runM6Fixture({ row: { "Short Description": raw } });
  assert.equal(result.update.processing_status, "READY_FOR_PUBLISH");
  assert.equal(result.update.final_description, linked(raw));
  assert.equal(result.state.raw.short_description, raw);
  assert.deepEqual(result.counters.editor_calls, []);
  assert.deepEqual(result.counters.validator_calls, []);
  for (const fixture of [{}, { eligibility_responses: [REVIEW_DECISION] }, { eligibility_responses: [SALES_DECISION] }, { eligibility_responses: ["bad"] }]) {
    const { state } = await runM6Fixture(fixture);
    state.draft_description = "📌 " + linked("Teach adults.") + " ✅";
    if (state.processing_status === "READY_FOR_PUBLISH") state.final_description = state.draft_description;
    const persisted = await executeCode("Prepare Terminal Persistence", state);
    assert.equal(persisted.draft_description, linked("Teach adults."));
    assert.equal(persisted.final_description, state.processing_status === "READY_FOR_PUBLISH" ? linked("Teach adults.") : "");
    assert.equal(persisted.processing_status, state.processing_status);
  }
});

test("KEEP stays within the soft budget; a longer submission is shaped by MINIMAL and never truncated (Section 13.1)", async () => {
  for (const size of [600, 900, 901, 3000]) {
    const text = "Teach adults. ".padEnd(size, "x");
    const result = await runM6Fixture({ row: { "Short Description": text } });
    const overBudget = size > CONFIG.max_publication_description_chars;
    assert.equal(result.update.processing_status, "READY_FOR_PUBLISH", String(size));
    assert.equal(result.update.initial_editorial_mode, overBudget ? "MINIMAL" : "KEEP", String(size));
    assert.match(result.state.editorial_reason, overBudget ? /exceeds the publication budget/ : /./, String(size));
    // The fixture editor returns the submission unchanged: exceeding the budget is not a failure.
    assert.equal(result.update.final_description, linked(text));
    assert.equal(result.update.draft_description, result.update.final_description);
    assert.equal(result.state.raw.short_description, text);
    assert.deepEqual(result.counters.editor_calls, overBudget ? ["MINIMAL"] : []);
    assert.equal(result.state.validation_attempts, 1);
  }
});

test("KEEP is never applied to a submission with a contact channel (Section 13.1)", async () => {
  for (const contact of ["Резюме — в Telegram: @exampleteacher1", "Пишите на hr@teach.example", "Наш телеграм: https://t.me/teachschool", "Звоните +7 900 765-43-21"]) {
    const text = `Teach adults online. ${contact}`;
    const routed = await runM6Fixture({
      row: { "Short Description": text },
      editor_responses: { MINIMAL: [{ project_link_text: "Teach", draft_description: "Teach adults online.", facts_added: [] }] },
    });
    assert.equal(routed.update.initial_editorial_mode, "MINIMAL", contact);
    assert.match(routed.state.editorial_reason, /contains contact channels/, contact);
    assert.equal(routed.update.final_description, linked("Teach adults online."), contact);
    // A MINIMAL candidate that keeps the contact fails deterministically; KEEP cannot rescue it.
    const kept = await runM6Fixture({ row: { "Short Description": text } });
    assert.deepEqual(plain(kept.state.validation_history.map(({ mode, issues }) => [mode, issues])),
      [["MINIMAL", ["OTHER_CONTRACT_VIOLATION"]], ["KEEP", ["OTHER_CONTRACT_VIOLATION"]]], contact);
    assert.equal(kept.update.processing_status, "NEEDS_REVIEW", contact);
    assert.match(kept.update.review_reason, /В заявке есть контакты/, contact);
    assert.deepEqual(kept.counters.validator_calls, [], contact);
  }
});

test("long MINIMAL and ENRICH candidates pass factual validation without length fallback", async () => {
  const source = Array(4).fill(PUBLICATION_SOURCE).join("\n");
  const added = "Evening classes.";
  for (const mode of ["MINIMAL", "ENRICH"]) {
    const draft = source + (mode === "ENRICH" ? "\n" + added : "");
    const result = await runM6Fixture({
      row: { "Short Description": source },
      eligibility_responses: [{ ...ACCEPT_KEEP, project_link_text: "Simulative", editorial_mode: mode }],
      ...(mode === "ENRICH" ? {
        readable_sources: ["original_link"],
        worker_responses: { original_link: workerSuccess(added) },
      } : {}),
      editor_responses: { [mode]: [{ project_link_text: "Simulative", draft_description: draft,
        facts_added: mode === "ENRICH" ? [{ fact: added, source: "original_link", evidence: added }] : [] }] },
    });
    assert.ok(Array.from(result.update.final_description).length > 600);
    assert.equal(result.update.processing_status, "READY_FOR_PUBLISH");
    assert.equal(result.update.final_editorial_mode, mode);
    assert.equal(result.update.final_description, linked(draft, "Simulative"));
    assert.equal(result.update.draft_description, result.update.final_description);
    assert.deepEqual(result.counters.editor_calls, [mode]);
    assert.deepEqual(result.counters.validator_calls, [mode]);
    assert.match(result.counters.validator_inputs[0].body.input[0].content[0].text, /never fail a draft for wording, block order, structure, headings, its opening or its length/);
    assert.equal(result.state.validation_attempts, 1);
  }
});

test("retired publication settings cannot impose a prompt target or a persistence limit", async () => {
  const config = { ...CONFIG, publication_body_target_min_chars: -1, publication_body_target_max_chars: 1, publication_body_max_chars: 0 };
  const source = Array(4).fill(PUBLICATION_SOURCE).join("\n");
  const result = await runM6Fixture({ config, row: { "Short Description": source },
    eligibility_responses: [{ ...ACCEPT_KEEP, project_link_text: "Simulative", editorial_mode: "MINIMAL" }] });
  assert.equal(result.update.processing_status, "READY_FOR_PUBLISH");
  assert.equal(result.update.final_description, linked(source, "Simulative"));
  assert.equal(result.state.publication_body_max_chars, undefined);
  for (const mode of ["MINIMAL", "ENRICH"]) {
    for (const retry of [false, true]) {
      const name = mode + " Editor" + (retry ? " Contract Retry" : "");
      const body = evaluateJsonBody(name, {
        ["Begin " + mode + " Attempt"]: result.m5State,
        ["Validate " + mode + " EditedContent"]: { state: result.m5State, raw_text: "invalid", contract_error: "invalid" },
      }, config);
      const prompt = body.input[0].content[0].text;
      assert.match(prompt, /Cut repetition, praise, promotional digressions and details outside the post elements first/);
      assert.match(prompt, /do not pad a short submission/);
      // The budget arrives as workflow_metadata; no numeric target is written into the prompt.
      assert.doesNotMatch(prompt, /Aim for (?:about |at most )?\d|maximum of \d|\b(?:350|450|600|765|900)\b/);
    }
  }
});

test("long candidates still fail unsupported facts and preserve the existing fallback chain", async () => {
  const source = Array(4).fill(PUBLICATION_SOURCE).join("\n");
  const result = await runM6Fixture({
    row: { "Short Description": source },
    eligibility_responses: [{ ...ACCEPT_KEEP, project_link_text: "Simulative", editorial_mode: "MINIMAL" }],
    editor_responses: { MINIMAL: [{ project_link_text: "Simulative", draft_description: source + " Guaranteed bonus.", facts_added: [] }] },
    validator_responses: { MINIMAL: [{ decision: "FAIL", issues: [{ type: "UNSUPPORTED_FACT", text: "Guaranteed bonus.", reason: "No supporting fact in the submission." }] }] },
  });
  assert.equal(result.update.final_editorial_mode, "KEEP");
  assert.equal(result.update.final_description, linked(source, "Simulative"));
  assert.deepEqual(plain(result.state.validation_history).map(({ mode, decision, issues }) => ({ mode, decision, issues })), [
    { mode: "MINIMAL", decision: "FAIL", issues: ["UNSUPPORTED_FACT"] },
    { mode: "KEEP", decision: "PASS", issues: [] },
  ]);
});

test("long Unicode bodies preserve sanitation without a length gate", async () => {
  const body = "Teach adults. " + "𐐀".repeat(700);
  const result = await runM6Fixture({ row: { "Short Description": "🔥 " + body + " ✅" } });
  assert.equal(result.update.processing_status, "READY_FOR_PUBLISH");
  assert.equal(result.update.final_description, linked(body));
  assert.ok(result.update.final_description.length > Array.from(result.update.final_description).length);
});

test("reviewer and rejected working copies stay emoji-free; deterministic fallback never dumps the page", async () => {
  const fullContext = `${REVIEWER_VACANCY}\n${"Дополнительно: готовить материалы для абитуриентов и проводить встречи. ".repeat(6)}📌`;
  const short = `${REVIEWER_SHORT} 🔥`;
  const fixture = reviewerRecoveryFixture({
    row: { "Short Description": short },
    config: { max_llm_source_chars: 2000, max_extracted_chars: 3000 },
    worker_responses: { original_link: workerSuccess(fullContext) },
  });
  for (const decision of [REVIEW_DECISION, SALES_DECISION]) {
    const result = await runM6Fixture({ ...fixture, eligibility_responses: [decision] });
    // A validated editor candidate may exceed the soft budget; it is kept, not truncated.
    assert.ok(result.update.draft_description.length > 600);
    assert.doesNotMatch(result.update.draft_description, /\p{Extended_Pictographic}/u);
    assert.equal(result.update.final_description, "");
    assert.equal(result.update.processing_status, decision === REVIEW_DECISION ? "NEEDS_REVIEW" : "REJECTED");
    assert.match(result.counters.editor_inputs[0].body.input[0].content[0].text, /never as pasted page text/);
    assert.deepEqual(plain(result.state.validation_history), []);
  }
  const state = await forcedKeepRecoveryState(fixture);
  const update = await executeCode("Prepare Terminal Persistence", state);
  assertRecoveredReview(update, state, linked(short, "РЭШ"));
  assert.doesNotMatch(update.draft_description, /\p{Extended_Pictographic}|Дополнительно/u);
});

const LINK_BODY = 'Музей «Коллекция» ищет медиатора. Нужно проводить занятия для взрослых и готовить материалы. Требуется опыт преподавания. Работа по гибкому графику.';
const LINK_MENTION = '«Коллекция»';
const LINK_URL = 'https://museum.example/';
function linkFixture(overrides = {}) {
  return {
    ...overrides,
    row: { 'Short Description': LINK_BODY, 'Project Website Link': LINK_URL, ...(overrides.row ?? {}) },
    eligibility_responses: overrides.eligibility_responses ?? [{ ...ACCEPT_KEEP, employer_name: 'Музей «Коллекция»', project_link_text: LINK_MENTION, editorial_mode: overrides.mode ?? 'KEEP' }],
  };
}

test('project links: KEEP links both columns without editor or validator', async () => {
  for (const project of [LINK_URL, 'museum.example', '[Музей](https://museum.example/)', 'https://t.me/museum']) {
    const result = await runM6Fixture(linkFixture({ row: { 'Project Website Link': project } }));
    assert.equal(result.update.processing_status, 'READY_FOR_PUBLISH');
    assert.equal(result.update.draft_description, linked(LINK_BODY, LINK_MENTION, result.state.normalized.project_link));
    assert.equal(result.update.final_description, result.update.draft_description);
    assert.equal(result.update.project_link_text, LINK_MENTION);
    assert.equal(result.update.employer_name, 'Музей «Коллекция»');
    // Stage 3 fetches both links; an unsupported social Project Link is not fetched.
    assert.deepEqual(result.counters.worker_calls, project.includes('t.me') ? ['original_link'] : ['original_link', 'project_link']);
    assert.deepEqual(result.counters.editor_calls, []);
    assert.deepEqual(result.counters.validator_calls, []);
  }
});

test('project links: MINIMAL and ENRICH select their own grammatical mention; the validator sees the body without the link', async () => {
  const candidate = LINK_BODY.replace('Музей «Коллекция» ищет медиатора.', 'В Коллекции нужен медиатор.');
  for (const mode of ['MINIMAL', 'ENRICH']) {
    const detail = 'Опыт от двух лет.';
    const result = await runM6Fixture(linkFixture({ mode,
      ...(mode === 'ENRICH' ? {
        readable_sources: ["original_link"],
        worker_responses: { original_link: workerSuccess(detail) },
      } : {}),
      editor_responses: { [mode]: [{ draft_description: candidate + (mode === 'ENRICH' ? ' ' + detail : ''), project_link_text: 'Коллекции', facts_added: mode === 'ENRICH' ? [{ fact: detail, source: 'original_link', evidence: detail }] : [] }] },
    }));
    assert.equal(result.update.processing_status, 'READY_FOR_PUBLISH');
    assert.equal(result.update.project_link_text, 'Коллекции');
    assert.match(result.update.final_description, /^В \[Коллекции\]\(https:\/\/museum.example\/\)/);
    assert.equal(result.update.draft_description, result.update.final_description);
    assert.deepEqual(result.counters.editor_calls, [mode]);
    const validator = result.counters.validator_inputs[0].body;
    const input = JSON.parse(validator.input[1].content[0].text).untrusted_validation_data;
    // Section 14.1: the selection and the code-created link are not validator input.
    assert.equal('project_link_text' in input, false);
    assert.equal(input.draft_description, candidate + (mode === 'ENRICH' ? ' ' + detail : ''));
    assert.doesNotMatch(validator.input[0].content[0].text, /project_link_text/);
    if (mode === 'MINIMAL') {
      const editor = JSON.parse(result.counters.editor_inputs[0].body.input[1].content[0].text);
      assert.deepEqual(editor.untrusted_source_data, { short_description: LINK_BODY });
      assert.deepEqual(input.approved_external_context, {});
      assert.doesNotMatch(JSON.stringify(editor), /museum\.example|employer_name|project_link_text/);
    }
  }
});

test('project links: earlier alias is selected and repeated mentions link only once', async () => {
  const body = 'КЛ ищет медиатора. Музей «Коллекция» проводит занятия для взрослых. В КЛ нужно готовить материалы.';
  const result = await runM6Fixture(linkFixture({ row: { 'Short Description': body }, eligibility_responses: [{ ...ACCEPT_KEEP, employer_name: 'Музей «Коллекция»', project_link_text: 'КЛ' }] }));
  assert.equal(result.update.final_description, '[КЛ](https://museum.example/) ищет медиатора. Музей «Коллекция» проводит занятия для взрослых. В КЛ нужно готовить материалы.');
  const classified = result.m5State;
  const prompt = evaluateJsonBody('Eligibility Contract Retry', { 'M4 Source Acquisition Complete': classified, 'Validate Eligibility Decision': { raw_text: '{}', contract_error: 'missing field' } }).input[0].content[0].text;
  assert.match(prompt, /earlier abbreviation/);
  assert.match(prompt, /never copy a name from the links into it/);
});

test('project links: failed editor metadata cannot enter MINIMAL or KEEP fallback', async () => {
  const minimal = LINK_BODY.replace('«Коллекция»', 'Коллекция');
  const base = linkFixture({ mode: 'ENRICH',
    readable_sources: ["original_link"],
    worker_responses: { original_link: workerSuccess('График вечерний.') },
    editor_responses: {
      ENRICH: [{ draft_description: LINK_BODY, project_link_text: 'Absent stale alias', facts_added: [{ fact: 'График вечерний.', source: 'original_link', evidence: 'График вечерний.' }] }],
      MINIMAL: [{ draft_description: minimal, project_link_text: 'Коллекция', facts_added: [] }],
    },
  });
  const passed = await runM6Fixture(base);
  assert.equal(passed.update.final_editorial_mode, 'MINIMAL');
  assert.equal(passed.update.project_link_text, 'Коллекция');
  assert.deepEqual(plain(passed.state.validation_history[0].issues), ['OTHER_CONTRACT_VIOLATION']);
  base.editor_responses.MINIMAL[0].project_link_text = null;
  const keep = await runM6Fixture(base);
  assert.equal(keep.update.final_editorial_mode, 'KEEP');
  assert.equal(keep.update.project_link_text, LINK_MENTION);
  assert.equal(keep.update.final_description, linked(LINK_BODY, LINK_MENTION, LINK_URL));
  assert.deepEqual(keep.counters.editor_calls, ['ENRICH', 'MINIMAL']);
});

test('project selection: candidate inflection is independent of submission and canonical identity', async () => {
  const submittedName = 'Северная академия';
  const candidateName = 'Северной академии';
  const detail = 'Работодатель оплачивает обучение.';
  const short = submittedName + ' ищет методиста. Нужно готовить уроки и проводить занятия для взрослых. Требуется опыт преподавания. Работа удалённая.';
  const candidate = short.replace(submittedName + ' ищет методиста.', 'В **' + candidateName + '** нужен методист.');
  for (const mode of ['MINIMAL', 'ENRICH']) {
    for (const selection of [candidateName, submittedName]) {
      const draft = { draft_description: candidate + (mode === 'ENRICH' ? ' ' + detail : ''), project_link_text: selection,
        facts_added: mode === 'ENRICH' ? [{ fact: detail, source: 'original_link', evidence: detail }] : [] };
      const before = structuredClone(draft);
      const result = await runM6Fixture(linkFixture({
        row: { 'Short Description': short },
        eligibility_responses: [{ ...ACCEPT_KEEP, employer_name: submittedName, project_link_text: submittedName, editorial_mode: mode }],
        ...(mode === 'ENRICH' ? {
          readable_sources: ["original_link"],
          worker_responses: { original_link: workerSuccess(detail) },
        } : {}),
        editor_responses: { [mode]: [draft] },
      }));
      const valid = selection === candidateName;
      assert.deepEqual(draft, before);
      assert.equal(result.state.raw.short_description, short);
      assert.equal(result.update.project_link_text, valid ? candidateName : submittedName);
      assert.equal(result.update.final_description, linked(valid ? draft.draft_description : short, valid ? candidateName : submittedName, LINK_URL));
      assert.deepEqual(result.counters.editor_calls, !valid && mode === 'ENRICH' ? ['ENRICH', 'MINIMAL'] : [mode]);
      assert.deepEqual(result.counters.validator_calls, valid ? [mode] : mode === 'ENRICH' ? ['MINIMAL'] : []);
      assert.equal(result.state.validation_history[0].decision, valid ? 'PASS' : 'FAIL');
      if (!valid) assert.deepEqual(plain(result.state.validation_history[0].issues), ['OTHER_CONTRACT_VIOLATION']);
      assert.equal(result.counters.persistence_updates, 1);
      for (const input of result.counters.editor_inputs.filter(item => item.mode === 'MINIMAL')) {
        assert.deepEqual(JSON.parse(input.body.input[1].content[0].text), { untrusted_source_data: { short_description: short }, workflow_metadata: editorMetadata(short) });
      }
    }
  }
});

// Explicit mock semantic findings exercise the established boundary and routing;
// they do not prove that a model selects/classifies these spans correctly.
// 2026-10-06 amendment (Section 6.7): the selecting call owns the selection; code
// places it exactly, and the semantic validator never sees or re-judges it.
test('project selection: a present selection is placed exactly as selected and never sent to the validator', async () => {
  const work = ' Нужно готовить уроки и проводить занятия для взрослых. Требуется опыт преподавания. Работа удалённая.';
  for (const [opening, selection] of [
    ['СА (Северная академия) ищет методиста. Команда Северной академии помогает преподавателям.', 'СА'],
    ['Отдел программ Северной академии ищет методиста.', 'Северной академии'],
  ]) {
    const body = opening + work;
    for (const reviewer of [false, true]) {
      const result = await runM6Fixture(linkFixture({
        row: { 'Short Description': body },
        eligibility_responses: [{ ...(reviewer ? REVIEW_DECISION : { ...ACCEPT_KEEP, editorial_mode: 'MINIMAL' }), project_link_text: selection }],
        editor_responses: { [reviewer ? 'ENRICH' : 'MINIMAL']: [{ draft_description: body, project_link_text: selection, facts_added: [] }] },
      }));
      const payload = JSON.parse(result.counters.validator_inputs[0].body.input[1].content[0].text).untrusted_validation_data;
      assert.equal('project_link_text' in payload, false);
      assert.equal(payload.draft_description, body);
      assert.equal(result.update.draft_description, linked(body, selection, LINK_URL));
      assert.equal(result.update.project_link_text, selection);
      assert.equal(result.update.processing_status, reviewer ? 'NEEDS_REVIEW' : 'READY_FOR_PUBLISH');
      assert.equal(result.update.final_description, reviewer ? '' : result.update.draft_description);
      assert.equal(result.state.raw.short_description, body);
    }
  }
});

test('project selection: reliable short names and unresolved reviewer identity need no forced canonical name', async () => {
  const work = ' Нужно готовить уроки и проводить занятия для взрослых. Требуется опыт преподавания. Работа удалённая.';
  for (const [opening, selection] of [
    ['СА (Северная академия) ищет методиста.', 'СА'],
    ['Отдел программ Северной академии ищет методиста.', 'Северной академии'],
    ['Учебная студия автора «Контур» ищет методиста.', '«Контур»'],
    ['Один из двух неназванных учебных проектов ищет методиста.', null],
  ]) {
    const body = opening + work;
    const result = await runM6Fixture(linkFixture({
      row: { 'Short Description': body },
      eligibility_responses: [{ ...REVIEW_DECISION, employer_name: null, project_link_text: selection }],
      editor_responses: { ENRICH: [{ draft_description: body, project_link_text: selection, facts_added: [] }] },
      validator_responses: { ENRICH: [VALIDATION_PASS] },
    }));
    assert.equal(result.update.draft_description, selection ? linked(body, selection, LINK_URL) : body);
    assert.equal(result.update.project_link_text, selection ?? '');
    assert.equal(result.update.final_description, '');
    assert.equal(result.update.processing_status, 'NEEDS_REVIEW');
    assert.deepEqual(result.counters.editor_calls, ['ENRICH']);
    assert.deepEqual(result.counters.validator_calls, ['ENRICH']);
  }
});

test('project links: missing mention preserves accepted reviewer copy without changing eligibility', async () => {
  const result = await runM6Fixture(linkFixture({ mode: 'MINIMAL',
    eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: 'MINIMAL', project_link_text: null }],
    editor_responses: { MINIMAL: [{ draft_description: LINK_BODY, project_link_text: null, facts_added: [] }] },
  }));
  assert.equal(result.update.processing_status, 'NEEDS_REVIEW');
  assert.equal(result.update.eligibility_decision, 'ACCEPT');
  assert.equal(result.update.primary_reason, '');
  assert.equal(result.update.project_link_text, '');
  assert.equal(result.update.draft_description, LINK_BODY);
  assert.equal(result.update.final_description, '');
  assert.deepEqual(plain(result.state.validation_history).map((v) => v.issues), [['OTHER_CONTRACT_VIOLATION'], ['OTHER_CONTRACT_VIOLATION']]);
});

test('project links: reviewer drafts survive placement-only failures', async () => {
  for (const reason of ['valid', 'missing', 'malformed', 'bad-url']) {
    const candidate = reason === 'malformed' ? LINK_BODY + ' [broken' : LINK_BODY;
    const result = await runM6Fixture(linkFixture({
      row: reason === 'bad-url' ? { 'Project Website Link': 'malformed' } : {},
      eligibility_responses: [{ ...REVIEW_DECISION, project_link_text: LINK_MENTION }],
      editor_responses: { ENRICH: [{ draft_description: candidate, project_link_text: reason === 'missing' ? null : LINK_MENTION, facts_added: [] }] },
    }));
    assert.equal(result.update.processing_status, reason === 'bad-url' ? 'REJECTED' : 'NEEDS_REVIEW');
    assert.equal(result.update.draft_description, reason === 'valid' ? linked(candidate, LINK_MENTION, LINK_URL) : candidate, reason);
    assert.equal(result.update.project_link_text, reason === 'valid' ? LINK_MENTION : '', reason);
    assert.equal(result.update.final_description, '');
    assert.deepEqual(result.counters.editor_calls, ['ENRICH']);
  }
});

test('project links: unread links reviewed by the combined decision, errors, broken and unrelated sources keep their outcomes', async () => {
  for (const [failure, status, primary] of [['EXTRACTION_FAILED', 'NEEDS_REVIEW', ''], ['LINK_BROKEN', 'REJECTED', 'LINK_BROKEN'], ['integration', 'ERROR', '']]) {
    const fixture = linkFixture({
      readable_sources: ["project_link"],
      ...(failure === 'EXTRACTION_FAILED' ? { eligibility_responses: [{ ...REVIEW_DECISION, project_link_text: LINK_MENTION, review_reason: 'Не удалось прочитать сайт проекта.' }] } : {}),
      ...(failure === 'integration' ? { worker_integration_errors: { project_link: { message: 'unavailable' } } } : { worker_responses: { project_link: workerFailure(failure, failure === "LINK_BROKEN" ? { status: "broken" } : {}) } }),
      editor_responses: { ENRICH: [{ draft_description: LINK_BODY, project_link_text: LINK_MENTION, facts_added: [] }] },
    });
    // Inject at the same worker transport boundary as the workflow's existing ERROR regression.
    if (failure === 'integration') {
      const before = await runFixture({ ...fixture, stop_before_eligibility: true, worker_responses: { project_link: workerSuccess('Museum teaches adults.') } });
      const node = nodes.get('Project Worker Integration Error');
      assert.ok(node);
      const error = await executeCode(node.name, { message: 'unavailable' }, { 'Original Source Ready': before.state });
      assert.equal(error.processing_status, status);
      const update = await executeCode('Prepare Terminal Persistence', error);
      assert.equal(update.final_description, '');
      continue;
    }
    const result = await runM6Fixture(fixture);
    assert.equal(result.update.processing_status, status);
    assert.equal(result.update.primary_reason, primary);
    assert.equal(result.update.final_description, '');
    assert.equal(result.update.draft_description, linked(LINK_BODY, LINK_MENTION, LINK_URL));
    assert.deepEqual(result.counters.worker_calls, ['original_link', 'project_link']);
  }
  const unrelated = await runM6Fixture(linkFixture({
    readable_sources: ["project_link"],
    worker_responses: { project_link: workerSuccess('Unrelated company.') },
    eligibility_responses: [{ ...SALES_DECISION, project_link_text: LINK_MENTION, primary_reason: 'WRONG_LINK_TARGET', reasons: ['WRONG_LINK_TARGET'], evidence: [{ source: 'project_link', reason: 'WRONG_LINK_TARGET', text: 'Unrelated company.' }] }],
    editor_responses: { ENRICH: [{ draft_description: LINK_BODY, project_link_text: LINK_MENTION, facts_added: [] }] },
  }));
  assert.equal(unrelated.update.processing_status, 'REJECTED');
  assert.equal(unrelated.update.primary_reason, 'WRONG_LINK_TARGET');
  assert.equal(unrelated.update.final_description, '');
  assert.equal(unrelated.update.draft_description, linked(LINK_BODY, LINK_MENTION, LINK_URL));
});

test('project links: correct/wrong existing links and KEEP exact comparison permit only the wrapper', async () => {
  for (const oldUrl of [LINK_URL, 'https://wrong.example/']) {
    const body = LINK_BODY.replace(LINK_MENTION, `[${LINK_MENTION}](${oldUrl})`);
    const result = await runM6Fixture(linkFixture({ row: { 'Short Description': body } }));
    assert.equal(result.update.final_description, LINK_BODY.replace(LINK_MENTION, `[${LINK_MENTION}](${LINK_URL})`));
    const state = await executeCode('Initialize KEEP Editorial', result.m5State);
    const envelope = await executeCode('Execute Deterministic KEEP', state);
    envelope.draft.draft_description += ' [extra](https://invented.example/)';
    const failed = await executeCode('Validate Deterministic KEEP', envelope);
    assert.equal(failed.processing_status, 'NEEDS_REVIEW');
    assert.ok(failed.validation_history[0].issues.includes('MEANING_LOST'));
  }
  const invented = await runM6Fixture(linkFixture({ mode: 'MINIMAL', editor_responses: { MINIMAL: [{ draft_description: linked(LINK_BODY, LINK_MENTION, LINK_URL), project_link_text: LINK_MENTION, facts_added: [] }] } }));
  assert.equal(invented.update.final_editorial_mode, 'KEEP');
  assert.ok(invented.state.validation_history[0].issues.includes('FORBIDDEN_SOURCE_USAGE'));
});

test('project links: long Unicode bodies and encoded destinations remain publishable', async () => {
  const url = 'https://museum.example/a(b)/🔥';
  const base = LINK_BODY + ' ';
  const overhead = Array.from(linked(base + 'x', LINK_MENTION, url)).length - Array.from(base + 'x').length;
  const exact = base + '𐐀'.repeat(600 - overhead - Array.from(base).length);
  for (const [extra, status] of [['', 'READY_FOR_PUBLISH'], ['𐐀', 'READY_FOR_PUBLISH']]) {
    const body = exact + extra;
    const result = await runM6Fixture(linkFixture({ row: { 'Short Description': '🔥 ' + body, 'Project Website Link': url } }));
    assert.equal(result.update.processing_status, status);
    assert.equal(Array.from(result.update.draft_description).length, 600 + (extra ? 1 : 0));
    assert.equal(result.update.final_description, result.update.draft_description);
    assert.equal(sanitizePublicationText(result.update.draft_description), result.update.draft_description);
  }
});

test('project links: strict schemas, correction retry, persisted column and rerun reset', async () => {
  const { state } = await runFixture(linkFixture({ stop_before_eligibility: true, row: { project_link_text: 'Stale Sheet edit' } }));
  assert.equal(state.project_link_text, null);
  const decision = { ...ACCEPT_KEEP, project_link_text: LINK_MENTION };
  for (const value of [undefined, 4, {}]) {
    const checked = await executeCode('Validate Eligibility Decision', responseWithText({ ...decision, project_link_text: value }), { 'M4 Source Acquisition Complete': state });
    assert.equal(checked.contract_valid, false);
  }
  const result = await runM6Fixture(linkFixture({ mode: 'MINIMAL',
    eligibility_responses: [{ ...decision, project_link_text: undefined }, { ...decision, editorial_mode: 'MINIMAL' }],
    editor_responses: { MINIMAL: [{ draft_description: LINK_BODY, facts_added: [] }, { draft_description: LINK_BODY, facts_added: [], project_link_text: LINK_MENTION }] },
  }));
  assert.equal(result.update.processing_status, 'READY_FOR_PUBLISH');
  assert.equal(result.counters.eligibility_calls, 2);
  assert.deepEqual(result.counters.editor_calls, ['MINIMAL', 'MINIMAL']);
  for (const request of result.counters.editor_inputs) assert.ok(request.body.text.format.schema.required.includes('project_link_text'));
  assert.equal(result.update.project_link_text, LINK_MENTION);
  assert.equal(nodes.get('Persist Terminal State').parameters.columns.value.project_link_text, '={{ $json.project_link_text }}');
  for (const patch of [{ project_link_text: null }, { final_description: LINK_BODY }, { draft_description: LINK_BODY }]) {
    await assert.rejects(() => executeCode('Prepare Terminal Persistence', { ...result.state, ...patch }), /valid first-mention project link/);
  }
});

test('project links: the reviewer working copy drops a stale selection without a reliable submission selection', async () => {
  const state = await forcedKeepRecoveryState({ eligibility_responses: [{ ...ACCEPT_KEEP, project_link_text: null }] });
  state.project_link_text = 'Stale failed draft name';
  const update = await executeCode('Prepare Terminal Persistence', state);
  assert.equal(update.draft_description, REVIEWER_SHORT);
  assert.equal(update.project_link_text, '');
  assert.equal(update.final_description, '');
  assert.equal(update.processing_status, 'NEEDS_REVIEW');
});

test('row 17 working copy: reuse the original employer selection on the submission after all publication attempts fail', async () => {
  const short = '"Онлайн Гимназия №1" открыла декретную вакансию "Учитель физики", нагрузка 21у.ч.';
  const employer = 'Онлайн Гимназия №1';
  const duties = 'Обязанности: вести онлайн-уроки физики для 7–9 классов и проверять домашние задания';
  const context = [
    '# Учитель физики В архиве с 27 февраля 2026',
    'Выплаты: два раза в месяц', 'Опыт работы: 1–3 года', 'График: 5/2',
    'Формат работы: на месте работодателя, удалённо или гибрид',
    duties,
    '## Вакансия в архиве',
    'Работодатель, вероятно, уже нашел нужного кандидата и больше не принимает отклики на эту вакансию',
    '## Вакансии из других подборок', '- Учитель', '- Преподаватель', '- Педагог', '- Репетитор',
  ].join('\n\n');
  // Every publication attempt must fail for recovery to run; a recorded gap on
  // what the work involves blocks MINIMAL and KEEP (Sections 10.2 and 13.0.2).
  const gap = 'WORK';
  const result = await runM6Fixture(reviewerRecoveryFixture({
    row: { 'Short Description': short, 'Project Website Link': 'https://og1.ru/' },
    worker_responses: { original_link: workerSuccess(context) },
    eligibility_responses: [{ ...ACCEPT_KEEP, employer_name: employer, project_link_text: employer, editorial_mode: 'ENRICH', material_gaps: [gap] }],
    editor_responses: {
      ENRICH: [{ draft_description: short, project_link_text: employer, facts_added: [] }],
      MINIMAL: [{ draft_description: short, project_link_text: employer, facts_added: [] }],
    },
  }));
  assert.equal(result.update.project_link_text, employer);
  // Section 15.1: no candidate reached the semantic validator, so the submission is the working copy.
  assertRecoveredReview(result.update, result.state, linked(short, employer, 'https://og1.ru/'));
  assert.equal(result.update.processing_status, 'NEEDS_REVIEW');
  assert.equal(result.update.eligibility_decision, 'ACCEPT');
  assert.deepEqual(result.counters.editor_calls, ['ENRICH', 'MINIMAL']);
  assert.deepEqual(result.counters.validator_calls, []);
  assert.deepEqual(plain(result.state.validation_history.map(attempt => attempt.mode)), ['ENRICH', 'MINIMAL', 'KEEP']);
  assert.deepEqual(plain(result.state.validation_history.map(attempt => attempt.issues)), [['OTHER_CONTRACT_VIOLATION'], ['MEANING_LOST'], ['MEANING_LOST']]);
  assert.equal(result.state.raw.short_description, short);
  assert.equal(result.update.original_link_context, context);
});

test('the reviewer working copy ignores failed-editor metadata and links only the unchanged submission', async () => {
  const state = await forcedKeepRecoveryState();
  state.project_link_text = 'Stale failed draft name';
  state.draft_description = 'Stale failed draft name';
  const snapshot = plain(state);
  const update = await executeCode('Prepare Terminal Persistence', state);
  assert.equal(update.project_link_text, 'РЭШ');
  assertRecoveredReview(update, state, linked(REVIEWER_SHORT, 'РЭШ'));
  assert.deepEqual(plain(state), snapshot);
  assert.equal((update.draft_description.match(/\]\(https:/g) ?? []).length, 1);
});

test('the reviewer working copy cannot derive a selection from employer_name or page context', async () => {
  for (const selection of [null, 'Специалист отдела приема', 'Home']) {
    const state = await forcedKeepRecoveryState();
    state.submission_project_link_text = selection;
    state.employer_name = 'РЭШ';
    state.project_link_text = 'РЭШ';
    if (selection === 'Home') state.sources.original_link.used_context += '\n\nHome';
    const update = await executeCode('Prepare Terminal Persistence', state);
    assert.equal(update.project_link_text, '');
    assertRecoveredReview(update, state, REVIEWER_SHORT);
  }
});

test('the reviewer working copy keeps unsupported Markdown intact and unresolved even with a valid submission selection', async () => {
  const state = await forcedKeepRecoveryState();
  state.normalized.short_description += ' [Unclosed link';
  const update = await executeCode('Prepare Terminal Persistence', state);
  assert.equal(update.project_link_text, '');
  assertRecoveredReview(update, state, REVIEWER_SHORT + ' [Unclosed link');
});

test('the reviewer working copy may retain a submission link without changing rejection or validation evidence', async () => {
  const state = await forcedKeepRecoveryState();
  Object.assign(state, {
    processing_status: 'REJECTED', eligibility_decision: 'REJECT', primary_reason: 'SALES', reasons: ['SALES'],
    eligibility_evidence: [{ source: 'short_description', reason: 'SALES', text: 'Existing rejection evidence.' }],
    review_reason: null, editorial_mode: null, initial_editorial_mode: null, validation_history: [], validation_attempts: 0,
    draft_description: null, project_link_text: null,
    m6: { draft_only: true, draft_context: { original_link: REVIEWER_VACANCY }, reviewer_validation: { decision: 'FAIL', issues: ['MEANING_LOST'] }, complete: true },
  });
  const update = await executeCode('Prepare Terminal Persistence', state);
  assert.equal(update.project_link_text, 'РЭШ');
  assertRecoveredReview(update, state, linked(REVIEWER_SHORT, 'РЭШ'));
});

test('project links: semantic validator rejects a later canonical name when an earlier alias exists', async () => {
  const body = 'КЛ ищет медиатора. Музей «Коллекция» проводит занятия для взрослых. Нужно готовить материалы и проводить занятия. Требуется опыт преподавания.';
  const result = await runM6Fixture(linkFixture({
    row: { 'Short Description': body },
    eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: 'MINIMAL', project_link_text: 'КЛ' }],
    editor_responses: { MINIMAL: [{ draft_description: body, project_link_text: LINK_MENTION, facts_added: [] }] },
    validator_responses: { MINIMAL: [{ decision: 'FAIL', issues: [{ type: 'OTHER_CONTRACT_VIOLATION', text: 'project_link_text', reason: 'КЛ is the earlier supported project alias.' }] }] },
  }));
  assert.equal(result.update.final_editorial_mode, 'KEEP');
  assert.equal(result.update.project_link_text, 'КЛ');
  assert.equal(result.update.final_description, linked(body, 'КЛ', LINK_URL));
  assert.deepEqual(result.counters.validator_calls, ['MINIMAL']);
  assert.equal(result.state.validation_history[0].decision, 'FAIL');
  const rejected = await runM6Fixture(linkFixture({
    eligibility_responses: [{ ...REVIEW_DECISION, project_link_text: LINK_MENTION }],
    editor_responses: { ENRICH: [{ draft_description: LINK_BODY, project_link_text: LINK_MENTION, facts_added: [] }] },
    validator_responses: { ENRICH: [{ decision: 'FAIL', issues: [
      { type: 'OTHER_CONTRACT_VIOLATION', text: 'project_link_text', reason: 'Wrong identity.' },
      { type: 'UNSUPPORTED_FACT', text: 'Unconfirmed statement.', reason: 'No evidence.' },
    ] }] },
  }));
  // A factual issue disqualifies the candidate; the submission keeps its own selection.
  assert.equal(rejected.update.draft_description, linked(LINK_BODY, LINK_MENTION, LINK_URL));
  assert.equal(rejected.update.project_link_text, LINK_MENTION);
  assert.equal(rejected.update.final_description, '');
  assert.equal(rejected.update.processing_status, 'NEEDS_REVIEW');
});

test('project links: every editor and reviewer schema rejects omitted or non-string selections on both retries', async () => {
  for (const mode of ['MINIMAL', 'ENRICH', 'REVIEWER']) {
    const actualMode = mode === 'MINIMAL' ? 'MINIMAL' : 'ENRICH';
    const { state: classified } = await runFixture(linkFixture(mode === 'REVIEWER'
      ? { row: { 'Contact Info': '@examplebot' } }
      : { mode: actualMode }));
    const prepared = await executeCode(mode === 'REVIEWER' ? 'Prepare Reviewer Draft' : `Initialize ${actualMode} Editorial`, classified);
    const state = await executeCode(`Begin ${actualMode} Attempt`, prepared);
    for (const selection of [undefined, 7, {}]) {
      const response = { draft_description: LINK_BODY, project_link_text: selection, facts_added: [],
        ...(mode === 'REVIEWER' ? { role_title: null, employer_name: null } : {}) };
      const first = await executeCode(`Validate ${actualMode} EditedContent`, responseWithText(response), { [`Begin ${actualMode} Attempt`]: state });
      assert.equal(first.contract_valid, false, mode);
      const retry = await executeCode(`Validate ${actualMode} EditedContent Retry`, responseWithText({ ...response, project_link_text: LINK_MENTION }), { [`Validate ${actualMode} EditedContent`]: first });
      assert.equal(retry.contract_valid, true, mode);
      assert.deepEqual(plain(retry.state), plain(state));
      for (const [name, outputs] of [
        [`${actualMode} Editor`, { [`Begin ${actualMode} Attempt`]: state }],
        [`${actualMode} Editor Contract Retry`, { [`Validate ${actualMode} EditedContent`]: first }],
      ]) {
        const request = evaluateJsonBody(name, outputs);
        assert.ok(request.text.format.schema.required.includes('project_link_text'));
        assert.deepEqual(request.text.format.schema.properties.project_link_text.type, ['string', 'null']);
        assert.match(request.input[0].content[0].text, /that first name the employer or project/);
        assert.match(request.input[0].content[0].text, /a department, course, role, partner or client does not/);
        assert.match(request.input[0].content[0].text, /It is null only when your draft never names the employer, even in a reviewer copy or when a link could not be read/);
        assert.match(request.text.format.schema.properties.project_link_text.description, /Exact first mention of the employer in draft_description, or null/);
      }
    }
  }
});

test('reported review rows: failed sources do not prevent supported employer links in reviewer drafts', async () => {
  for (const [employer, failure] of [['Школа Alles', 'FETCH_FAILED'], ['Сириус.Курсы', 'FETCH_FAILED'], ['Kodland', 'EXTRACTION_FAILED']]) {
    const text = `${employer} ищет преподавателя. Нужно готовить материалы и проводить занятия. Возможна удалённая работа.`;
    const reviewReason = 'Не удалось прочитать страницу вакансии.';
    const result = await runM6Fixture({
      row: { 'Short Description': text },
      worker_responses: { original_link: workerFailure(failure) },
      eligibility_responses: [{ ...REVIEW_DECISION, employer_name: employer, project_link_text: employer, review_reason: reviewReason }],
      editor_responses: { ENRICH: [{ draft_description: text, project_link_text: employer, facts_added: [] }] },
    });
    assert.equal(result.update.processing_status, 'NEEDS_REVIEW');
    assert.equal(result.update.review_reason, reviewReason);
    assert.equal(result.update.project_link_text, employer);
    assert.equal(result.update.draft_description, linked(text, employer));
    assert.equal(result.update.final_description, '');
    assert.deepEqual(result.counters.editor_calls, ['ENRICH']);
    assert.deepEqual(result.counters.validator_calls, ['ENRICH']);
    assert.equal(result.counters.eligibility_calls, 1);
    const editor = result.counters.editor_inputs[0].body;
    assert.deepEqual(JSON.parse(editor.input[1].content[0].text).untrusted_source_data.approved_external_context, {});
    assert.match(editor.input[0].content[0].text, /even in a reviewer copy or when a link could not be read/);
  }
});

test('reported row 22 shape: a post-eligibility reviewer draft selects its own supported employer mention', async () => {
  const text = 'Онлайн Школа Практической Психотерапии ищет маркетолога. Нужно готовить контент и анализировать результаты. Работа удалённая.';
  const employer = 'Онлайн Школа Практической Психотерапии';
  const result = await runM6Fixture({
    row: { 'Short Description': text },
    eligibility_responses: [{ ...REVIEW_DECISION, employer_name: employer, project_link_text: employer, review_reason: 'Required vacancy content could not be safely understood.' }],
    editor_responses: { ENRICH: [{ draft_description: text, project_link_text: employer, facts_added: [] }] },
  });
  assert.equal(result.update.processing_status, 'NEEDS_REVIEW');
  assert.equal(result.update.draft_description, linked(text, employer));
  assert.equal(result.update.project_link_text, employer);
  assert.equal(result.update.final_description, '');
  assert.deepEqual(result.counters.editor_calls, ['ENRICH']);
  assert.equal(result.counters.eligibility_calls, 1);
});

test('reported row 10 shape: link the college when its department appears first', async () => {
  const employer = 'ГБПОУ «26 КАДР»';
  const text = `На отделении «Архитектура и дизайн» ${employer} открыто 4 вакансии. Нужно организовывать занятия и готовить материалы.`;
  for (const mode of ['KEEP', 'MINIMAL']) {
    const result = await runM6Fixture({
      row: { 'Short Description': text },
      eligibility_responses: [{ ...ACCEPT_KEEP, employer_name: employer, project_link_text: employer, editorial_mode: mode }],
      editor_responses: { MINIMAL: [{ draft_description: text, project_link_text: employer, facts_added: [] }] },
    });
    assert.equal(result.update.processing_status, 'READY_FOR_PUBLISH');
    assert.equal(result.update.project_link_text, employer);
    assert.equal(result.update.final_description, linked(text, employer));
    assert.match(result.update.final_description, /^На отделении «Архитектура и дизайн» \[ГБПОУ/);
    assert.match(result.counters.eligibility_inputs[0].input[0].content[0].text, /a department, course, subject, role, partner or client named earlier does not/);
  }
});

test('reported row 17: short maternity-cover hiring announcement reaches reviewer editor and preserves workload', async () => {
  const text = '"Онлайн Гимназия №1" открыла декретную вакансию "Учитель физики", нагрузка 21у.ч.';
  const employer = 'Онлайн Гимназия №1';
  for (const decision of [REVIEW_DECISION, { ...SALES_DECISION, primary_reason: 'LINK_BROKEN', reasons: ['LINK_BROKEN'], evidence: [{ reason: 'LINK_BROKEN', source: 'original_link', text: 'Вакансия в архиве' }] }]) {
    const result = await runM6Fixture({
      row: { 'Short Description': text },
      readable_sources: ["original_link"],
      worker_responses: { original_link: workerSuccess('Учитель физики. Вакансия в архиве.') },
      // Replay the old rejection too: the draft fix cannot silently override eligibility.
      eligibility_responses: [{ ...decision, employer_name: employer, role_title: 'Учитель физики', project_link_text: employer }],
      editor_responses: { ENRICH: [{ draft_description: text, project_link_text: employer, facts_added: [] }] },
    });
    assert.equal(result.update.processing_status, decision.decision === 'REJECT' ? 'REJECTED' : 'NEEDS_REVIEW');
    assert.equal(result.update.draft_description, linked(text, employer));
    assert.match(result.update.draft_description, /декретную вакансию.*нагрузка 21у\.ч\./);
    assert.equal(result.update.final_description, '');
    assert.deepEqual(result.counters.editor_calls, ['ENRICH']);
    assert.deepEqual(result.counters.validator_calls, ['ENRICH']);
    assert.deepEqual(plain(result.state.eligibility_evidence), plain(result.m5State.eligibility_evidence));
  }
});

test('eligibility initial and retry prompts distinguish archive labels from objectively broken links', async () => {
  const result = await runFixture({ eligibility_responses: ['invalid-json', REVIEW_DECISION] });
  assert.equal(result.counters.eligibility_inputs.length, 2);
  for (const body of result.counters.eligibility_inputs) {
    const prompt = body.input[0].content[0].text;
    assert.match(prompt, /An archived or closed vacancy that is still shown is neither LINK_BROKEN nor a reason to reject or review: judge it on the remaining material like any other vacancy/);
    assert.match(prompt, /A page that only shows an error such as «страница не найдена» is LINK_BROKEN/);
    assert.deepEqual(body.text.format.schema.properties.reasons.items.enum, EXPECTED_REJECTION_REASONS);
  }
});

test('reported row 19 shape: a founder-named hiring business may receive the project link', async () => {
  const text = 'Команда Екатерины Гончаровой ищет проджект-менеджера образовательного бизнеса. Нужно управлять запусками и процессами.';
  const employer = 'Екатерины Гончаровой';
  const result = await runM6Fixture({
    row: { 'Short Description': text },
    eligibility_responses: [{ ...ACCEPT_KEEP, employer_name: 'образовательный бизнес Екатерины Гончаровой', project_link_text: employer, editorial_mode: 'MINIMAL' }],
    editor_responses: { MINIMAL: [{ draft_description: text, project_link_text: employer, facts_added: [] }] },
  });
  assert.equal(result.update.processing_status, 'READY_FOR_PUBLISH');
  assert.equal(result.update.draft_description, linked(text, employer));
  assert.equal(result.update.final_description, result.update.draft_description);
  assert.match(result.counters.editor_inputs[0].body.input[0].content[0].text, /a founder's name counts only when the text presents the hiring business as that person's project/);
  assert.match(result.counters.eligibility_inputs[0].input[0].content[0].text, /a founder's name counts only when the text presents the hiring business as that person's project/);
});

test("runner length diagnostics count visible Unicode code points, excluding link destinations (Section 13.0.1)", async () => {
  const before = [{ ...VALID_ROW, "Short Description": "A𐐀B" }];
  const draft = "[A𐐀B](https://example.com)";
  const result = await executeCode("Build Runner Result", [{ ...before[0], draft_description: draft }], {
    "Read Sheet Rows For Selection And Duplicates": before,
    "Prepare Terminal Persistence": { processing_status: "NEEDS_REVIEW", draft_description: draft, final_description: "" },
  });
  assert.equal(result.input_chars, 3);
  assert.equal(result.draft_chars, 3);
  assert.equal(result.final_chars, 0);
  assert.equal(result.invariant_ok, true);
});


test("source noise: Apply Eligibility Decision forces ENRICH only for a bare announcement whose vacancy page describes the work", async () => {
  await verifySourceNoiseOverride(workflow);
});

test("source noise: retaining MINIMAL does not make a bare title publishable, and no page dump replaces it", async () => {
  const result = await runM6Fixture(groupingFixture({
    row: { "Short Description": sparseTitle },
    worker_responses: { original_link: workerSuccess(noisyEmployerContext) },
    eligibility_responses: [{ ...ACCEPT_KEEP, project_link_text: "Example University", editorial_mode: "MINIMAL" }],
    editor_responses: { MINIMAL: [{ project_link_text: "Example University", draft_description: sparseTitle, facts_added: [] }] },
  }));
  assert.equal(result.state.initial_editorial_mode, "MINIMAL");
  assert.deepEqual(result.counters.editor_calls, ["MINIMAL"]);
  assert.deepEqual(result.counters.validator_calls, []);
  assert.deepEqual(plain(result.state.validation_history), [
    { attempt: 1, mode: "MINIMAL", decision: "FAIL", issues: ["MEANING_LOST"] },
    { attempt: 2, mode: "KEEP", decision: "FAIL", issues: ["MEANING_LOST"] },
  ]);
  assert.equal(result.update.processing_status, "NEEDS_REVIEW");
  assert.equal(result.update.final_description, "");
  assert.equal(result.update.original_link_context, noisyEmployerContext);
  // Section 15.1: a bare title is not a usable working copy and page text is never appended.
  assert.equal(result.update.draft_description, "");
  assert.deepEqual(result.rawBeforePersistence, plain(result.state.raw));
  assert.equal(result.counters.persistence_updates, 1);
});

test("severe collapse: shared helper is invariant to candidate formatting and preserves faithful content", () => {
  verifyCompletenessGrouping(workflow);
});

function groupingFixture(overrides = {}) {
  return {
    row: { "Short Description": splitCandidate },
    config: { max_llm_source_chars: 5000, max_extracted_chars: 10000 },
    readable_sources: ["original_link"],
    worker_responses: { original_link: workerSuccess(vacancyContext) },
    eligibility_responses: [{ ...ACCEPT_KEEP, project_link_text: "Example Academy", editorial_mode: "MINIMAL" }],
    ...overrides,
  };
}

test("severe collapse: a candidate that collapses the submission itself fails, and KEEP publishes the complete submission", async () => {
  // Section 14.4: the Short Description is the completeness reference.
  const result = await runM6Fixture(groupingFixture({
    row: { "Short Description": completeReference },
    editor_responses: { MINIMAL: [{ project_link_text: "Example Academy", draft_description: splitCandidate, facts_added: [] }] },
  }));
  assert.equal(result.state.initial_editorial_mode, "MINIMAL");
  assert.deepEqual(result.counters.editor_calls, ["MINIMAL"]);
  assert.deepEqual(result.counters.validator_calls, []);
  assert.deepEqual(plain(result.state.validation_history), [
    { attempt: 1, mode: "MINIMAL", decision: "FAIL", issues: ["MEANING_LOST"] },
    { attempt: 2, mode: "KEEP", decision: "PASS", issues: [] },
  ]);
  assert.equal(result.update.processing_status, "READY_FOR_PUBLISH");
  assert.equal(result.update.final_description, linked(completeReference, "Example Academy"));
  assert.equal(result.counters.persistence_updates, 1);
  assert.deepEqual(result.rawBeforePersistence, plain(result.state.raw));
});

test("severe collapse: a sufficient submission publishes without the page details it leaves to the details link", async () => {
  const result = await runM6Fixture(groupingFixture({
    editor_responses: { MINIMAL: [{ project_link_text: "Example Academy", draft_description: splitCandidate, facts_added: [] }] },
  }));
  assert.equal(result.state.initial_editorial_mode, "MINIMAL");
  assert.deepEqual(result.counters.editor_calls, ["MINIMAL"]);
  assert.deepEqual(result.counters.validator_calls, ["MINIMAL"]);
  assert.equal(result.update.processing_status, "READY_FOR_PUBLISH");
  assert.equal(result.update.final_description, linked(splitCandidate, "Example Academy"));
  assert.equal(result.update.original_link_context, vacancyContext);
});

test("severe collapse: KEEP of a sufficient submission publishes even when the vacancy page is far richer", async () => {
  for (const short of [mergedCandidate, splitCandidate]) {
    const result = await runM6Fixture(groupingFixture({
      row: { "Short Description": short },
      eligibility_responses: [{ ...ACCEPT_KEEP, project_link_text: "Example Academy", editorial_mode: "KEEP" }],
    }));
    assert.deepEqual(plain(result.state.validation_history), [{ attempt: 1, mode: "KEEP", decision: "PASS", issues: [] }]);
    assert.equal(result.update.processing_status, "READY_FOR_PUBLISH");
    assert.equal(result.update.final_description, linked(short, "Example Academy"));
    assert.deepEqual(result.counters.editor_calls, []);
  }
});

test("severe collapse: a reviewer-only draft of a sufficient submission stays a post-ready body without page dumps", async () => {
  for (const decision of [REVIEW_DECISION, SALES_DECISION]) {
    const result = await runM6Fixture(groupingFixture({
      eligibility_responses: [{ ...decision, project_link_text: "Example Academy" }],
      editor_responses: { ENRICH: [{ project_link_text: "Example Academy", draft_description: splitCandidate, facts_added: [] }] },
    }));
    assert.deepEqual(plain(result.state.m6.reviewer_validation), VALIDATION_PASS);
    assert.deepEqual(result.counters.editor_calls, ["ENRICH"]);
    assert.deepEqual(result.counters.validator_calls, ["ENRICH"]);
    assert.deepEqual(plain(result.state.validation_history), []);
    assert.equal(result.state.editorial_mode, null);
    assert.equal(result.state.eligibility_decision, decision.decision);
    assert.equal(result.update.processing_status, decision.decision === "REJECT" ? "REJECTED" : "NEEDS_REVIEW");
    assert.equal(result.update.draft_description, linked(splitCandidate, "Example Academy"));
    assert.equal(result.update.final_description, "");
    assert.equal(result.counters.persistence_updates, 1);
  }
});

test("severe collapse: mode selection never forces ENRICH for a sufficient submission, whatever the page contains", async () => {
  for (const short of [mergedCandidate, splitCandidate]) {
    for (const mode of ["KEEP", "MINIMAL"]) {
      const decision = { ...ACCEPT_KEEP, project_link_text: "Example Academy", editorial_mode: mode };
      const result = await runFixture(groupingFixture({ row: { "Short Description": short }, eligibility_responses: [decision] }));
      assert.equal(result.state.editorial_mode, mode, "a rich vacancy page is not a gap");
      assert.equal(result.state.eligibility_decision, "ACCEPT");
      for (const context of noisyContexts) {
        const state = plain(result.state);
        state.sources.original_link.used_context = context;
        const applied = await executeCode("Apply Eligibility Decision", { state, decision });
        assert.equal(applied.editorial_mode, mode, "navigation/news/statistics cannot force ENRICH");
        assert.equal(applied.eligibility_decision, "ACCEPT");
      }
    }
  }
  const bare = await runFixture(groupingFixture({ row: { "Short Description": sparseTitle },
    eligibility_responses: [{ ...ACCEPT_KEEP, project_link_text: "Example University", editorial_mode: "KEEP" }] }));
  assert.equal(bare.state.editorial_mode, "ENRICH", "a bare title with a described vacancy page is forced to ENRICH");
});

// Synthetic evidence only: replay the generated check without model calls or
// quotation repair. The candidate stays fixed while only evidence changes.
test("evidence requires contiguous verbatim support with whitespace normalization", async () => {
  const context = "Evening groups meet weekly.\nTraining is provided.\n1. Prepare lessons.\n2. Review assignments.\nMore... details follow.\nКоманда планирует онбординг.";
  const record = (evidence, fact = evidence, source = "original_link") => ({ fact, source, evidence });
  const cases = [
    ["contiguous fragment", [record("Evening groups meet weekly.")], true],
    ["whitespace differences", [record("  Evening\tgroups meet weekly.\r\n Training is provided.  ")], true],
    ["list markers preserved", [record("1. Prepare lessons. 2. Review assignments.")], true],
    ["source ellipsis", [record("More... details follow.")], true],
    ["invented ellipsis", [record("Evening groups meet weekly. ... Review assignments.")], false],
    ["invented Unicode ellipsis", [record("Evening groups meet weekly. … Review assignments.")], false],
    ["removed sentence", [record("Evening groups meet weekly. 1. Prepare lessons.")], false],
    ["removed list marker", [record("Prepare lessons. Review assignments.")], false],
    ["paraphrased quotation", [record("Evening classes meet weekly.")], false],
    ["paraphrased fact keeps source terminology in evidence", [record("Команда планирует онбординг.", "Команда планирует адаптацию сотрудников.")], true],
    ["edited terminology inside quotation", [record("Команда планирует адаптацию сотрудников.")], false],
    ["changed source word form", [record("Команда планировала онбординг.")], false],
    ["changed source case", [record("команда планирует онбординг.")], false],
    ["changed source punctuation", [record("Команда планирует онбординг!")], false],
    ["split supported records", [
      record("Evening groups meet weekly.", "Groups meet weekly in the evening."),
      record("Review assignments.", "The role includes reviewing assignments."),
    ], true],
  ];
  for (const source of ["original_link", "project_link"]) {
    for (const draftOnly of [false, true]) {
      for (const [label, facts, supported] of cases) {
        const envelope = {
          state: {
            processing_status: draftOnly ? "NEEDS_REVIEW" : "PROCESSING",
            normalized: { short_description: "Teach adults.", project_link: VALID_ROW["Project Website Link"] },
            source_requirement: { [source + "_required"]: true },
            sources: { [source]: { status: "success", relation: "RELEVANT", used_context: context } },
            eligibility_evidence: [],
            m6: { current_mode: "ENRICH", draft_only: draftOnly, draft_context: { [source]: context } },
          },
          draft: {
            project_link_text: "Teach", draft_description: "Teach adults.\n" + context,
            facts_added: facts.map((item) => ({ ...item, source })),
          },
        };
        const before = structuredClone(envelope);
        const result = await executeCode("Deterministic ENRICH Output Check", envelope);
        assert.deepEqual(plain(result.deterministic_result), {
          decision: supported ? "PASS" : "FAIL", issues: supported ? [] : ["UNSUPPORTED_FACT"],
        }, `${source}, reviewer=${draftOnly}: ${label}`);
        assert.deepEqual(plain(result.draft.facts_added), envelope.draft.facts_added, "evidence must not be repaired");
        assert.deepEqual(envelope, before, "raw inputs must remain unchanged");
      }
    }
  }
});

test("evidence comparison ignores invisible format characters but nothing visible (D-023, execution 520)", async () => {
  // The OSTAZ project page had a U+200C before «ОSТАZ»; the editor's visually exact quotation lacked it.
  const visible = "оказывающий услуги под наименованием «Центр проектных смен»";
  for (const hidden of ["\u200c", "\u200b", "\u00ad", "\u2060", "\ufeff"]) {
    const context = visible.replace("«", hidden + "«");
    const check = async (evidence) => (await executeCode("Deterministic ENRICH Output Check", {
      state: {
        processing_status: "PROCESSING",
        normalized: { short_description: "Teach adults.", project_link: VALID_ROW["Project Website Link"] },
        source_requirement: { project_link_required: false },
        sources: { project_link: { status: "success", relation: "RELEVANT", used_context: context } },
        eligibility_evidence: [], m6: { current_mode: "ENRICH", draft_only: false },
      },
      draft: { project_link_text: "Teach", draft_description: "Teach adults. Центр проектных смен.",
        facts_added: [{ source: "project_link", fact: "Центр проектных смен.", evidence }] },
    })).deterministic_result.issues;
    assert.deepEqual(plain(await check(visible)), [], JSON.stringify(hidden));
    assert.deepEqual(plain(await check(visible.replace("проектных", "проектныx"))), ["UNSUPPORTED_FACT"], "a visible change still fails");
  }
});

test("contiguous evidence still requires an available approved source", async () => {
  const context = "Evening groups meet weekly.";
  // A successfully read non-required page is approved (Stage 3), so it is not an exclusion.
  const exclusions = {
    missing: (state, source) => { delete state.sources[source]; },
    failed: (state, source) => { state.sources[source].status = "extraction_failed"; },
    broken: (state, source) => { state.sources[source].status = "broken"; },
    unused: (state, source) => { state.sources[source].status = "not_requested"; },
    irrelevant: (state, source) => { state.sources[source].relation = "WRONG_TARGET"; },
    "no useful content": (state, source) => { state.sources[source].relation = "NO_USEFUL_CONTENT"; },
    "empty used context": (state, source) => { state.sources[source].used_context = ""; },
    disputed: (state, source) => { state.eligibility_evidence = [{ source, reason: "WRONG_LINK_TARGET" }]; },
    "reviewer unselected": (state) => { state.m6.draft_only = true; state.m6.draft_context = {}; },
  };
  for (const source of ["original_link", "project_link"]) {
    for (const [label, exclude] of Object.entries(exclusions)) {
      const state = {
        processing_status: "PROCESSING",
        normalized: { short_description: "Teach adults.", project_link: VALID_ROW["Project Website Link"] },
        source_requirement: { [source + "_required"]: true },
        sources: { [source]: { status: "success", relation: "RELEVANT", used_context: context } },
        eligibility_evidence: [], m6: { current_mode: "ENRICH", draft_only: false },
      };
      exclude(state, source);
      const result = await executeCode("Deterministic ENRICH Output Check", {
        state, draft: {
          project_link_text: "Teach", draft_description: "Teach adults. " + context,
          facts_added: [{ source, fact: "Weekly evening groups.", evidence: context }],
        },
      });
      assert.deepEqual(plain(result.deterministic_result), {
        decision: "FAIL", issues: ["FORBIDDEN_SOURCE_USAGE"],
      }, `${source}: ${label}`);
    }
  }
});

test("spliced evidence follows existing fallback without an editor contract retry", async () => {
  const context = "Evening groups meet weekly. Training is provided. Review assignments.";
  const result = await runM6Fixture({
    readable_sources: ["original_link"],
    worker_responses: { original_link: workerSuccess(context) },
    eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: "ENRICH", editorial_reason: "Material role detail." }],
    editor_responses: { ENRICH: [{
      project_link_text: "Teach", draft_description: "Teach adults. " + context,
      facts_added: [{ source: "original_link", fact: "Weekly evening groups and assignment reviews.",
        evidence: "Evening groups meet weekly. ... Review assignments." }],
    }] },
  });
  assert.deepEqual(result.counters.editor_calls, ["ENRICH", "MINIMAL"]);
  assert.deepEqual(result.counters.validator_calls, ["MINIMAL"]);
  assert.deepEqual(plain(result.state.validation_history[0]), {
    attempt: 1, mode: "ENRICH", decision: "FAIL", issues: ["UNSUPPORTED_FACT"],
  });
  assert.equal(result.state.final_editorial_mode, "MINIMAL");
  assert.deepEqual(plain(result.state.facts_added), []);
});

// Semantic decisions below are explicit mocks. These fixtures prove that exact
// quotation matching is not an entailment/coverage classifier, and that the
// existing semantic result drives fallback without repair or regeneration.
test("ENRICH fact support and complete accounting keep semantic validation separate from exact matching", async () => {
  const short = "Teach Academy describes a tutor role: teach adults, prepare lessons and review assignments. Work is remote.";
  const archive = "Listing archived on 7 June 2031.";
  const workload = "The workload is 12 hours per week.";
  const benefit = "The team provides training.";
  const context = `${archive}\nListing is archived.\n${workload}\n${benefit}\nThe office opened on 9 May 2030.`;
  const record = (fact, evidence) => ({ fact, source: "original_link", evidence });
  const records = [
    record("Archived since 07.06.2031.", archive),
    record("The weekly workload is 12 hours.", workload),
    record("Training is provided by the team.", benefit),
  ];
  const candidate = short + " " + records.map(item => item.fact).join(" ");
  const cases = [
    { label: "complete support with faithful date/number paraphrases", facts: records },
    { label: "date omitted from exact quotation", facts: [record(records[0].fact, "Listing is archived."), ...records.slice(1)], issue: "UNSUPPORTED_FACT" },
    { label: "number omitted from exact quotation", facts: [records[0], record(records[1].fact, benefit), records[2]], issue: "UNSUPPORTED_FACT" },
    { label: "date belongs to another event", facts: [record("Archived since 09.05.2030.", "The office opened on 9 May 2030."), ...records.slice(1)], candidate: candidate.replace("07.06.2031", "09.05.2030"), issue: "UNSUPPORTED_FACT" },
    { label: "unrecorded external benefit", facts: records.slice(0, 2), issue: "OTHER_CONTRACT_VIOLATION" },
    { label: "one record only partly covers a compound claim", facts: [record(records.map(item => item.fact).join(" "), archive)], issue: "UNSUPPORTED_FACT" },
    { label: "unsupported adjective added to the fact and draft", facts: [...records.slice(0, 2), record("The experienced team provides training.", benefit)], candidate: candidate.replace(records[2].fact, "The experienced team provides training."), issue: "UNSUPPORTED_FACT" },
  ];
  for (const reviewer of [false, true]) {
    for (const example of cases) {
      const draft = { draft_description: example.candidate ?? candidate, project_link_text: "Teach", facts_added: example.facts };
      const before = structuredClone(draft);
      const result = await runM6Fixture({
        row: { "Short Description": short },
        config: { max_llm_source_chars: 10000, max_extracted_chars: 20000 },
        readable_sources: ["original_link"],
        worker_responses: { original_link: workerSuccess(context) },
        eligibility_responses: [reviewer ? REVIEW_DECISION : { ...ACCEPT_KEEP, editorial_mode: "ENRICH" }],
        editor_responses: { ENRICH: [draft] },
        validator_responses: { ENRICH: [example.issue ? {
          decision: "FAIL", issues: [{ type: example.issue, text: example.issue === "OTHER_CONTRACT_VIOLATION" ? records[2].fact : example.facts[0].fact,
            reason: `Synthetic semantic finding: ${example.label}.` }],
        } : VALIDATION_PASS] },
      });
      const label = `${example.label}, reviewer=${reviewer}`;
      // Reaching this request proves the unchanged deterministic check passed
      // all exact-but-insufficient quotations too. Evidence is never repaired.
      const request = result.counters.validator_inputs.find(item => item.mode === "ENRICH")?.body
        ?? result.counters.validator_inputs[0].body;
      const payload = JSON.parse(request.input[1].content[0].text).untrusted_validation_data;
      assert.deepEqual(payload.facts_added, example.facts, label);
      assert.deepEqual(payload.approved_external_context, { original_link: context }, label);
      assert.equal(payload.draft_description, sanitizePublicationText(draft.draft_description), label);
      assert.deepEqual(draft, before, label);
      assert.deepEqual(result.counters.editor_calls, !reviewer && example.issue ? ["ENRICH", "MINIMAL"] : ["ENRICH"], label);
      assert.deepEqual(result.counters.validator_calls, !reviewer && example.issue ? ["ENRICH", "MINIMAL"] : ["ENRICH"], label);
      assert.equal(result.counters.persistence_updates, 1, label);
      assert.equal(result.state.sources.original_link.used_context, context, label);
      assert.equal(result.state.raw.short_description, short, label);
      if (reviewer) {
        assert.equal(result.update.processing_status, "NEEDS_REVIEW", label);
        assert.equal(result.update.final_description, "", label);
        // Section 15.1: a factually failed reviewer candidate gives way to the submission.
        assert.equal(result.update.draft_description, example.issue ? linked(short) : linked(candidate), label);
        assert.equal(result.state.review_reason, REVIEW_DECISION.review_reason, label);
        assert.deepEqual(plain(result.state.validation_history), [], label);
      } else {
        assert.equal(result.state.final_editorial_mode, example.issue ? "MINIMAL" : "ENRICH", label);
        assert.deepEqual(plain(result.state.validation_history[0]), {
          attempt: 1, mode: "ENRICH", decision: example.issue ? "FAIL" : "PASS", issues: example.issue ? [example.issue] : [],
        }, label);
        if (example.issue) {
          assert.deepEqual(JSON.parse(result.counters.editor_inputs[1].body.input[1].content[0].text), {
            untrusted_source_data: { short_description: short },
            workflow_metadata: editorMetadata(short),
          }, label);
          assert.equal(result.update.final_description, linked(short), label);
        } else {
          assert.deepEqual(plain(result.state.facts_added), records, label);
          assert.equal(result.update.final_description, linked(candidate), label);
        }
      }
    }
  }
});

test("fallback completeness: missing whole facets are independent of other facets, length and paragraph layout", () => {
  const code = nodes.get("Deterministic MINIMAL Output Check").parameters.jsCode;
  const helpers = code.slice(code.indexOf("const MEANING_STOP_WORDS"), code.indexOf("\nconst issues = []"));
  const lost = vm.runInNewContext(`${helpers}; meaningHasWholeFacetLoss`);
  const layouts = text => [text, text.replace(/\n+/g, " "), text.replaceAll(". ", ".\n\n")];
  for (const missing of Object.keys(fallbackFacets)) {
    const remaining = Object.entries(fallbackFacets).filter(([facet]) => facet !== missing).map(([, text]) => text).join("\n");
    // Section 13.0.2: the essence block keeps duties, or requirements only when no duties are stated.
    const expected = missing !== "REQUIREMENTS";
    for (const reference of layouts(fallbackReference)) {
      for (const candidate of layouts(fallbackAnnouncement + "\n" + remaining)) {
        assert.equal(lost(reference, candidate), expected, `${missing}: ${candidate}`);
        if (expected) assert.equal(lost(reference, candidate + "\n" + missing[0] + missing.slice(1).toLowerCase() + ":"), true, "an empty heading is not coverage");
      }
      assert.equal(lost(reference, fallbackSummary), false, "faithful concise paraphrase without headings");
      assert.equal(lost(reference, fallbackAnnouncement + "\n" + fallbackReference), false, "complete original");
    }
  }
  const russian = "Обязанности: Разрабатывать уроки для взрослых. Проверять задания и готовить обратную связь.\nТребования: Опыт преподавания алгебры и знание методик обучения. Умение проектировать задания.\nУсловия работы: Удалённая работа с вечерними занятиями. Оформление по договору с оплатой подготовки.";
  const concise = "Teach ищет опытного преподавателя алгебры, умеющего проектировать задания: разработка уроков, проверка работ и обратная связь взрослым. Дистанционно по вечерам, договор, оплачиваемая подготовка.";
  for (const reference of [russian,
    russian.replace("Обязанности:", "Чем предстоит заниматься?\n").replace("Требования:", "Кого мы ищем:\n").replace("Условия работы:", "Формат работы:\n"),
    russian.replace("Обязанности:", "### Задачи\n").replace("Требования:", "### Что мы ожидаем от вас\n").replace("Условия работы:", "### Условия\n"),
  ]) {
    assert.equal(lost(reference, concise), false, "Russian paraphrase preserves facets");
    assert.equal(lost(reference, fallbackAnnouncement), true, "common heading forms preserve the missing-facet check");
  }
  for (const candidate of [fallbackAnnouncement, fallbackAnnouncement.replace("hiring an algebra teacher", "looking for a tutor")]) {
    assert.equal(lost(fallbackReference, candidate), true, "hiring and employer material cannot cover missing facets");
  }
  // Without stated duties, the key requirements are the essence block and must survive.
  const requirementsOnly = fallbackFacets.REQUIREMENTS + "\n\n" + fallbackFacets.CONDITIONS;
  assert.equal(lost(requirementsOnly, fallbackAnnouncement + "\n" + fallbackFacets.CONDITIONS), true, "requirements are the essence when no duties are stated");
  assert.equal(lost(requirementsOnly, fallbackAnnouncement + "\n" + requirementsOnly), false);
  for (const noisy of [noisyEmployerContext, ...noisyContexts]) {
    assert.equal(lost(noisy, "Teach is hiring a teacher for remote evening classes."), false, "noise alone creates no material obligations");
    assert.equal(lost(fallbackReference + "\n" + noisy, fallbackSummary), false, "ignore appended site material");
  }
  assert.equal(lost("Requirements:\nMenu\nStudent experience and opening hours for visitors.", fallbackAnnouncement), false, "navigation ends a section");
  assert.equal(lost("Requirements:\nPrivacy policy", fallbackAnnouncement), false, "heading plus boilerplate is not evidence");
  assert.equal(lost("Requirements: Expertise in experimental workshops.", "Teach seeks a tutor for experimental workshops."), false, "shared facet anchor leaves ambiguous meaning to semantic validation");
});

function fallbackCompletenessFixture(submission, overrides = {}) {
  return groupingFixture({
    row: { "Short Description": submission },
    worker_responses: { original_link: workerSuccess(fallbackReference) },
    eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: "ENRICH" }],
    editor_responses: {
      ENRICH: [{ project_link_text: "Teach", draft_description: submission + "\n" + fallbackReference,
        facts_added: [{ fact: "invented employment term", source: "original_link", evidence: "not in the approved source" }] }],
      MINIMAL: [{ project_link_text: "Teach", draft_description: submission, facts_added: [] }],
    },
    ...overrides,
  });
}

test("fallback completeness: an announcement without work description and a recorded gap exhausts fallback and keeps the submission for review", async () => {
  // Section 13.0.2: employer context plus a role title does not say what the work involves.
  const gap = "WORK";
  const result = await runM6Fixture(fallbackCompletenessFixture(fallbackAnnouncement, {
    eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: "ENRICH", material_gaps: [gap] }],
  }));
  assert.equal(result.update.processing_status, "NEEDS_REVIEW");
  assert.equal(result.update.eligibility_decision, "ACCEPT");
  assert.equal(result.update.final_description, "");
  assert.equal(result.update.final_editorial_mode, "");
  // Section 15.1: no candidate reached the semantic validator; the page is never appended.
  assert.equal(result.update.draft_description, linked(fallbackAnnouncement));
  assert.equal(result.update.original_link_context, fallbackReference);
  assert.deepEqual(plain(result.state.validation_history), [
    { attempt: 1, mode: "ENRICH", decision: "FAIL", issues: ["UNSUPPORTED_FACT"] },
    { attempt: 2, mode: "MINIMAL", decision: "FAIL", issues: ["MEANING_LOST"] },
    { attempt: 3, mode: "KEEP", decision: "FAIL", issues: ["MEANING_LOST"] },
  ]);
  assert.deepEqual(result.counters.editor_calls, ["ENRICH", "MINIMAL"]);
  assert.deepEqual(result.counters.validator_calls, []);
  assert.deepEqual(JSON.parse(result.counters.editor_inputs[1].body.input[1].content[0].text), {
    untrusted_source_data: { short_description: fallbackAnnouncement },
    workflow_metadata: editorMetadata(fallbackAnnouncement),
  });
  assert.deepEqual(result.rawBeforePersistence, plain(result.state.raw));
  assert.equal(result.counters.persistence_updates, 1);
});

test("fallback completeness: a submission that describes the work publishes through MINIMAL without page requirements or conditions", async () => {
  const submission = fallbackAnnouncement + "\n" + fallbackFacets.RESPONSIBILITIES;
  const result = await runM6Fixture(fallbackCompletenessFixture(submission));
  assert.equal(result.update.processing_status, "READY_FOR_PUBLISH");
  assert.equal(result.update.final_editorial_mode, "MINIMAL");
  assert.equal(result.update.final_description, linked(submission));
  assert.deepEqual(plain(result.state.validation_history.map((entry) => [entry.mode, entry.decision])), [["ENRICH", "FAIL"], ["MINIMAL", "PASS"]]);
});

test("fallback completeness: sufficient short and concise bodies still publish through MINIMAL or KEEP", async () => {
  const short = "Teach is hiring a teacher for remote evening classes.";
  for (const [submission, context] of [[short, "Teach is hiring a teacher for remote evening classes.\nHome\nMenu\nPrivacy policy"], [fallbackSummary, fallbackReference]]) {
    for (const fallback of ["MINIMAL", "KEEP"]) {
      const fixture = fallbackCompletenessFixture(submission, {
        worker_responses: { original_link: workerSuccess(context) },
        validator_responses: fallback === "KEEP" ? { MINIMAL: [{ decision: "FAIL", issues: [{ type: "OTHER_CONTRACT_VIOLATION", text: "Mock selection issue", reason: "Exercise KEEP after an independent MINIMAL failure." }] }] } : {},
      });
      // The failed ENRICH candidate is complete; its quotation alone is invalid.
      fixture.editor_responses.ENRICH[0].draft_description = submission;
      const result = await runM6Fixture(fixture);
      assert.equal(result.update.processing_status, "READY_FOR_PUBLISH");
      assert.equal(result.update.final_editorial_mode, fallback);
      assert.equal(result.update.final_description, linked(submission));
      assert.equal(result.update.draft_description, result.update.final_description);
      assert.deepEqual(result.counters.editor_calls, ["ENRICH", "MINIMAL"]);
      assert.deepEqual(result.counters.validator_calls, ["MINIMAL"]);
    }
  }
});

test("fallback completeness: MINIMAL cannot turn a bare input title into a sufficient hiring sentence", async () => {
  for (const [source, candidate, selection] of [
    ["Специалист цифровых сервисов университета Teach", "Университет Teach приглашает специалиста цифровых сервисов.", "Teach"],
    ["Digital services specialist at Teach", "Teach is hiring a digital services specialist.", "Teach"],
    ["Координатор программ в Teach", "В Teach открыта вакансия координатора программ.", "Teach"],
  ]) {
    const result = await runM6Fixture(groupingFixture({
      row: { "Short Description": source },
      worker_responses: { original_link: workerSuccess(noisyEmployerContext) },
      eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: "MINIMAL", project_link_text: selection }],
      editor_responses: { MINIMAL: [{ draft_description: candidate, project_link_text: selection, facts_added: [] }] },
    }));
    assert.equal(result.state.initial_editorial_mode, "MINIMAL", "noise cannot force ENRICH");
    assert.deepEqual(result.counters.editor_calls, ["MINIMAL"]);
    assert.deepEqual(result.counters.validator_calls, []);
    assert.equal(result.update.processing_status, "NEEDS_REVIEW");
    assert.equal(result.update.final_description, "");
    assert.deepEqual(plain(result.state.validation_history).map(item => item.issues), [["MEANING_LOST"], ["MEANING_LOST"]]);
    // A bare title is not a usable working copy, and page noise is never appended.
    assert.equal(result.update.draft_description, "");
  }
});

test("fallback completeness: only approved vacancy context may block publication; Project Link is not a vacancy reference", async () => {
  const short = "Teach is hiring a teacher for remote evening classes.";
  const base = (await runM6Fixture()).state;
  for (const [source, exclusion] of [
    ["original_link", "optional"], ["original_link", "failed"], ["original_link", "irrelevant"],
    ["original_link", "disputed"], ["original_link", "unused"], ["project_link", "none"],
  ]) {
    const state = plain(base);
    Object.assign(state, { processing_status: "PROCESSING", initial_editorial_mode: "MINIMAL", final_editorial_mode: null,
      validation_history: [], validation_attempts: 0, facts_added: [], draft_description: null, final_description: null,
      m6: { current_mode: "MINIMAL" } });
    state.normalized.short_description = short;
    state.source_requirement = { original_link_required: false, project_link_required: false, [source + "_required"]: true };
    state.sources[source] = { status: "success", relation: "RELEVANT", used_context: fallbackReference, title: "Vacancy" };
    if (exclusion === "optional") state.source_requirement[source + "_required"] = false;
    if (exclusion === "failed") state.sources[source].status = "extraction_failed";
    if (exclusion === "irrelevant") state.sources[source].relation = "NO_USEFUL_CONTENT";
    if (exclusion === "unused") state.sources[source].used_context = "";
    if (exclusion === "disputed") state.eligibility_evidence = [{ source, reason: "WRONG_LINK_TARGET", text: "unrelated" }];
    const envelope = { state, draft: { project_link_text: "Teach", draft_description: short, facts_added: [] } };
    const checked = await executeCode("Deterministic MINIMAL Output Check", envelope);
    assert.deepEqual(plain(checked.deterministic_result), VALIDATION_PASS, `${source}: ${exclusion}`);
    const keepState = { ...state, m6: { current_mode: "KEEP" } };
    const kept = await executeCode("Validate Deterministic KEEP", await executeCode("Execute Deterministic KEEP", keepState));
    assert.equal(kept.processing_status, "READY_FOR_PUBLISH", `${source}: ${exclusion}`);
  }
});

test("fallback completeness: a reviewer-only draft keeps a sufficient submission post-ready without changing rejection or review", async () => {
  const submission = fallbackAnnouncement + "\n" + fallbackFacets.RESPONSIBILITIES;
  for (const decision of [REVIEW_DECISION, SALES_DECISION]) {
    const result = await runM6Fixture(fallbackCompletenessFixture(submission, {
      eligibility_responses: [{ ...decision, project_link_text: "Teach" }],
      editor_responses: { ENRICH: [{ draft_description: submission, project_link_text: "Teach", facts_added: [] }] },
    }));
    assert.deepEqual(plain(result.state.m6.reviewer_validation), VALIDATION_PASS);
    assert.equal(result.state.eligibility_decision, decision.decision);
    assert.equal(result.state.processing_status, decision.decision === "REJECT" ? "REJECTED" : "NEEDS_REVIEW");
    assert.equal(result.state.primary_reason, decision.primary_reason);
    assert.equal(result.state.review_reason, decision.review_reason);
    assert.deepEqual(plain(result.state.eligibility_evidence), decision.evidence);
    assert.deepEqual(plain(result.state.validation_history), []);
    assert.equal(result.update.final_description, "");
    assert.equal(result.update.draft_description, linked(submission));
    assert.deepEqual(result.counters.editor_calls, ["ENRICH"]);
    assert.deepEqual(result.counters.validator_calls, ["ENRICH"]);
    assert.equal(result.counters.persistence_updates, 1);
  }
});

// Synthetic semantic responses exercise routing, not live model classification.
// 2026-10-06 amendment: whether a page describes the submitted vacancy is decided by
// EligibilityDecision (Section 11); the validator judges only the candidate (Section 14.3).
const CONFLICT_SUBMISSION = "Teach Academy hires a tutor to teach adults and prepare lessons. Work is fully remote on every weekday.";
const CONFLICT_CONTEXT = "The vacancy is a sales manager who sells course subscriptions by phone; it involves no teaching.";
const CONFLICT_REASON = "The supplied descriptions name different roles, so they cannot describe the same vacancy.";
function conflictFixture(extra = {}) {
  return {
    row: { "Short Description": CONFLICT_SUBMISSION },
    config: { max_llm_source_chars: 10000, max_extracted_chars: 20000 },
    readable_sources: ["original_link"],
    worker_responses: { original_link: workerSuccess(CONFLICT_CONTEXT) },
    eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: "ENRICH" }],
    ...extra,
  };
}

test("an established eligibility conflict stays review even when a factual draft says to clarify with the employer", async () => {
  const review = { ...REVIEW_DECISION, review_reason: CONFLICT_REASON };
  const result = await runM6Fixture(conflictFixture({
    eligibility_responses: [review],
    editor_responses: { ENRICH: [{ project_link_text: "Teach", draft_description: CONFLICT_SUBMISSION + " Уточните у работодателя.", facts_added: [] }] },
    validator_responses: { ENRICH: [VALIDATION_PASS] },
  }));
  assert.equal(result.update.processing_status, "NEEDS_REVIEW");
  assert.equal(result.update.review_reason, review.review_reason);
  assert.match(result.update.draft_description, /Уточните у работодателя/);
  assert.equal(result.update.final_description, "");
  assert.equal(result.update.final_editorial_mode, "");
  assert.deepEqual(plain(result.state.validation_history), []);
  assert.deepEqual(result.counters.editor_calls, ["ENRICH"]);
  assert.equal(result.counters.persistence_updates, 1);
});

test("compatible qualifications and explicitly equivalent role names remain accepted in all existing modes", async () => {
  const short = "Teach Academy hires a learning designer, also called an educational program architect in this vacancy. The role develops adult courses and requires four years of total work experience, including two years designing courses. Work is remote full time.";
  const context = "The two years designing courses are part of the four years of total experience; these are requirements for the same learning designer role.";
  for (const mode of ["KEEP", "MINIMAL", "ENRICH"]) {
    const result = await runM6Fixture(conflictFixture({
      row: { "Short Description": short },
      worker_responses: { original_link: workerSuccess(context) },
      eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: mode }],
    }));
    assert.equal(result.update.processing_status, "READY_FOR_PUBLISH", mode);
    assert.equal(result.update.final_editorial_mode, mode);
    assert.equal(result.update.draft_description, result.update.final_description);
  }
});

test("uncertain role alignment remains review while a demonstrated wrong vacancy excludes that source from drafting", async () => {
  const short = "Teach Academy hires a course designer to develop adult learning programs, with remote full-time work.";
  const unrelated = "Other Factory hires a machine operator for onsite production shifts; this is a separate vacancy.";
  for (const outcome of ["uncertain", "unrelated"]) {
    const source = outcome === "uncertain" ? "Teach Academy seeks a head of learning. Duties and relation to its designer vacancy are not provided." : unrelated;
    const decision = outcome === "uncertain"
      ? { ...REVIEW_DECISION, role_title: null, review_reason: "The relation of the leadership vacancy to the submitted designer role is unresolved." }
      : { ...SALES_DECISION, primary_reason: "WRONG_LINK_TARGET", reasons: ["WRONG_LINK_TARGET"], evidence: [{ reason: "WRONG_LINK_TARGET", source: "original_link", text: unrelated }] };
    const result = await runM6Fixture(conflictFixture({ row: { "Short Description": short }, worker_responses: { original_link: workerSuccess(source) }, eligibility_responses: [decision] }));
    assert.equal(result.update.processing_status, outcome === "uncertain" ? "NEEDS_REVIEW" : "REJECTED");
    assert.equal(result.update.final_description, "");
    assert.equal(result.update.original_link_context, source);
    assert.equal(result.counters.eligibility_calls, 1);
    assert.deepEqual(result.counters.editor_calls, ["ENRICH"]);
    if (outcome === "unrelated") {
      assert.deepEqual(JSON.parse(result.counters.editor_inputs[0].body.input[1].content[0].text).untrusted_source_data.approved_external_context, {});
      assert.doesNotMatch(result.update.draft_description, /Other Factory/);
    }
  }
});

test("a validator contradiction is a candidate issue: fallback recovers from the unchanged submission", async () => {
  for (const mode of ["ENRICH", "MINIMAL"]) {
    const result = await runM6Fixture(conflictFixture({
      worker_responses: { original_link: workerSuccess("The tutor prepares course materials.") },
      eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: mode }],
      validator_responses: { [mode]: [{ decision: "FAIL", issues: [{ type: "CONTRADICTION", text: "office attendance", reason: "Only the generated draft claims office attendance." }] }] },
    }));
    assert.equal(result.update.processing_status, "READY_FOR_PUBLISH", mode);
    assert.equal(result.update.final_editorial_mode, mode === "ENRICH" ? "MINIMAL" : "KEEP");
    assert.equal(result.update.final_description, linked(CONFLICT_SUBMISSION));
    assert.equal(result.state.m6.source_conflicts, undefined);
  }
});

test("the ValidationResult contract has no source_conflict field and the validator never re-judges vacancy identity", async () => {
  const result = await runM6Fixture(conflictFixture());
  const state = plain(result.state);
  state.processing_status = "PROCESSING";
  state.m6.current_mode = "ENRICH";
  state.m6.complete = false;
  const checked = { state, draft: defaultEditorResponse("ENRICH", state) };
  const extra = await executeCode("Validate ENRICH ValidationResult", responseWithText({ decision: "FAIL", issues: [{ type: "CONTRADICTION", source_conflict: true, text: "a / b", reason: "Different roles." }] }), { "Deterministic ENRICH Output Check": checked });
  assert.equal(extra.contract_valid, false);
  assert.match(extra.contract_error, /missing or additional properties/);
  const valid = await executeCode("Validate ENRICH ValidationResult", responseWithText({ decision: "FAIL", issues: [{ type: "CONTRADICTION", text: "a / b", reason: "Different roles." }] }), { "Deterministic ENRICH Output Check": checked });
  assert.equal(valid.contract_valid, true);
  for (const mode of ["MINIMAL", "ENRICH"]) {
    const request = evaluateJsonBody(`${mode} Validator`, { [`Deterministic ${mode} Output Check`]: checked });
    assert.deepEqual(request.text.format.schema.properties.issues.items.required, ["type", "text", "reason"]);
    assert.match(request.input[0].content[0].text, /You are a fact checker, not a style editor/);
    assert.doesNotMatch(request.input[0].content[0].text, /source_conflict|different role, employer or vacancy than the submission/);
  }
});

test("archived vacancies publish as ordinary posts; archive notices are excluded material (Section 13.0.2)", async () => {
  const short = "Teach Academy describes a tutor role: teach adults, prepare lessons and review assignments. Work is remote.";
  const opening = "Teach Academy is hiring a tutor: teach adults, prepare lessons and review assignments. Work is remote.";
  const archive = "Listing is archived.";
  const probable = "The employer probably found a candidate and probably no longer accepts applications.";
  const workload = "The workload is 12 hours per week.";
  const context = [archive, probable, workload].join("\n");
  const record = (fact, evidence = fact) => ({ fact, source: "original_link", evidence });
  const cases = [
    { label: "ordinary opening without the archive notice", text: opening + " " + workload, facts: [record(workload)] },
    { label: "no archive evidence needs no archive disclaimer", context: workload, text: short + " " + workload, facts: [record(workload)] },
    { label: "included archive notice is excluded material", text: short + " " + archive, facts: [record(archive)], issue: "OTHER_CONTRACT_VIOLATION", issueText: "excluded_material" },
    { label: "probability must not become certainty", text: short + " The employer definitely found a candidate.", facts: [record("The employer definitely found a candidate.", probable)], issue: "UNSUPPORTED_FACT" },
  ];
  for (const outcome of ["ACCEPT", "NEEDS_REVIEW", "REJECT"]) {
    for (const example of cases) {
      const source = example.context ?? context;
      const draft = { draft_description: example.text, project_link_text: "Teach", facts_added: example.facts };
      const before = structuredClone(draft);
      // These are explicit mocked semantic findings, not a semantic classifier
      // or golden labels derived from historical executions.
      const result = await runM6Fixture({
        row: { "Short Description": short },
        config: { max_llm_source_chars: 10000, max_extracted_chars: 20000 },
        readable_sources: ["original_link"],
        worker_responses: { original_link: workerSuccess(source) },
        eligibility_responses: [outcome === "ACCEPT" ? { ...ACCEPT_KEEP, editorial_mode: "ENRICH" }
          : outcome === "NEEDS_REVIEW" ? REVIEW_DECISION
          : { ...REVIEW_DECISION, decision: "REJECT", review_reason: null, primary_reason: "OUT_OF_SCOPE", reasons: ["OUT_OF_SCOPE"],
              evidence: [{ reason: "OUT_OF_SCOPE", source: "short_description", text: short }] }],
        editor_responses: { ENRICH: [draft] },
        validator_responses: { ENRICH: [example.issue ? { decision: "FAIL", issues: [{ type: example.issue,
          text: example.issueText ?? example.text, reason: `Synthetic semantic finding: ${example.label}.` }] } : VALIDATION_PASS] },
      });
      const label = `${outcome}: ${example.label}`;
      const request = result.counters.validator_inputs[0].body;
      const payload = JSON.parse(request.input[1].content[0].text).untrusted_validation_data;
      assert.deepEqual(payload.facts_added, example.facts, label);
      assert.deepEqual(payload.approved_external_context, { original_link: source }, label);
      assert.equal(payload.draft_description, sanitizePublicationText(example.text), label);
      assert.deepEqual(draft, before, label);
      for (const sent of [...result.counters.editor_inputs, ...result.counters.validator_inputs]) {
        // Archive notices are excluded material for editors and validators alike.
        assert.match(sent.body.input[0].content[0].text, /archive or closed status/, label);
        assert.doesNotMatch(sent.body.input[0].content[0].text, /В архивной вакансии проекта описана роль/, label);
        assert.equal(sent.retry, false, label);
      }
      const fallback = outcome === "ACCEPT" && Boolean(example.issue);
      assert.deepEqual(result.counters.editor_calls, fallback ? ["ENRICH", "MINIMAL"] : ["ENRICH"], label);
      assert.deepEqual(result.counters.validator_calls, fallback ? ["ENRICH", "MINIMAL"] : ["ENRICH"], label);
      assert.equal(result.counters.persistence_updates, 1, label);
      assert.equal(result.state.raw.short_description, short, label);
      assert.equal(result.state.sources.original_link.used_context, source, label);
      assert.equal(result.state.sources.original_link.status, "success", label);
      assert.equal(result.state.eligibility_decision, outcome, label);
      if (outcome === "ACCEPT") {
        assert.equal(result.state.final_editorial_mode, fallback ? "MINIMAL" : "ENRICH", label);
        assert.equal(result.update.draft_description, result.update.final_description, label);
        assert.deepEqual(plain(result.state.validation_history[0]), { attempt: 1, mode: "ENRICH",
          decision: example.issue ? "FAIL" : "PASS", issues: example.issue ? [example.issue] : [] }, label);
        if (fallback) {
          assert.deepEqual(JSON.parse(result.counters.editor_inputs[1].body.input[1].content[0].text),
            { untrusted_source_data: { short_description: short }, workflow_metadata: editorMetadata(short) }, label);
          assert.equal(result.update.final_description, linked(short), label);
        } else assert.equal(result.update.final_description, linked(example.text), label);
      } else {
        assert.equal(result.update.processing_status, outcome === "REJECT" ? "REJECTED" : "NEEDS_REVIEW", label);
        assert.equal(result.update.final_description, "", label);
        // Section 15.1: excluded material alone keeps the candidate; a factual issue does not.
        const keepsCandidate = !example.issue || example.issueText === "excluded_material";
        assert.equal(result.update.draft_description, keepsCandidate ? linked(example.text) : linked(short), label);
        assert.equal(result.state.final_editorial_mode, null, label);
        assert.deepEqual(plain(result.state.validation_history), [], label);
        assert.deepEqual(plain(result.state.reasons), outcome === "REJECT" ? ["OUT_OF_SCOPE"] : [], label);
        assert.equal(result.state.review_reason, outcome === "REJECT" ? null : REVIEW_DECISION.review_reason, label);
      }
    }
  }
});

test("archive wording leaves MINIMAL submission-only and KEEP deterministic", async () => {
  const short = "Teach Academy's archived listing describes a tutor role: teach adults, prepare lessons and review assignments. Work is remote. The employer probably found a candidate.";
  for (const mode of ["MINIMAL", "KEEP"]) {
    const result = await runM6Fixture({
      row: { "Short Description": short },
      eligibility_responses: [{ ...ACCEPT_KEEP, editorial_mode: mode }],
    });
    assert.equal(result.update.processing_status, "READY_FOR_PUBLISH");
    assert.equal(result.update.final_description, linked(short));
    assert.equal(result.update.draft_description, result.update.final_description);
    assert.deepEqual(result.counters.editor_calls, mode === "MINIMAL" ? ["MINIMAL"] : []);
    assert.deepEqual(result.counters.validator_calls, mode === "MINIMAL" ? ["MINIMAL"] : []);
    assert.deepEqual(plain(result.state.facts_added), []);
    assert.equal(result.counters.persistence_updates, 1);
    if (mode === "MINIMAL") {
      assert.deepEqual(JSON.parse(result.counters.editor_inputs[0].body.input[1].content[0].text),
        { untrusted_source_data: { short_description: short }, workflow_metadata: editorMetadata(short) });
      const input = JSON.parse(result.counters.validator_inputs[0].body.input[1].content[0].text).untrusted_validation_data;
      assert.deepEqual(input.approved_external_context, {});
      assert.deepEqual(input.facts_added, []);
    }
  }
});

test("meaning concision: paired semantic results preserve facts, fallback and the reviewer working copy", async () => {
  for (const path of ["MINIMAL", "ENRICH", "NEEDS_REVIEW", "REJECT"]) {
    const mode = path === "MINIMAL" ? "MINIMAL" : "ENRICH";
    const reviewer = ["NEEDS_REVIEW", "REJECT"].includes(path);
    for (const pair of concisionPairs) {
      for (const lost of [false, true]) {
        const body = (lost ? pair.lossy : pair.faithful) + (mode === "ENRICH" ? " " + concisionContext : "");
        const facts = mode === "ENRICH" ? [concisionFact] : [];
        const draft = { draft_description: body, project_link_text: "Teach", facts_added: facts };
        const before = structuredClone(draft);
        const decision = !reviewer ? { ...ACCEPT_KEEP, editorial_mode: mode }
          : path === "NEEDS_REVIEW" ? REVIEW_DECISION
          : { ...REVIEW_DECISION, decision: "REJECT", review_reason: null, primary_reason: "OUT_OF_SCOPE", reasons: ["OUT_OF_SCOPE"],
              evidence: [{ reason: "OUT_OF_SCOPE", source: "short_description", text: pair.short }] };
        const result = await runM6Fixture({
          row: { "Short Description": pair.short },
          source_requirement_responses: [{ original_link_required: mode === "ENRICH", project_link_required: false,
            reasons: { original_link: mode === "ENRICH" ? "Read reporting duties." : null, project_link: null } }],
          worker_responses: { original_link: workerSuccess(concisionContext) },
          eligibility_responses: [decision],
          editor_responses: { [mode]: [draft] },
          // Explicit mocked meaning judgments exercise existing control flow;
          // they do not prove that a live validator reaches these judgments.
          validator_responses: { [mode]: [lost ? { decision: "FAIL", issues: [{ type: "MEANING_LOST",
            text: pair.missing, reason: pair.reason }] } : VALIDATION_PASS] },
        });
        const label = `${path}: ${pair.name}, lost=${lost}`;
        assert.ok(result.counters.validator_inputs.length, `${label}: candidate reaches semantic validation`);
        const payload = JSON.parse(result.counters.validator_inputs[0].body.input[1].content[0].text).untrusted_validation_data;
        assert.equal(payload.draft_description, sanitizePublicationText(body), label);
        assert.equal(payload.short_description, pair.short, label);
        assert.deepEqual(payload.facts_added, facts, label);
        assert.deepEqual(payload.approved_external_context, mode === "ENRICH" ? { original_link: concisionContext } : {}, label);
        assert.deepEqual(draft, before, label);
        for (const sent of result.counters.editor_inputs) {
          assert.match(sent.body.input[0].content[0].text, /Within what you keep, do not soften or strengthen any requirement or condition/, label);
          assert.equal(sent.retry, false, label);
        }
        for (const sent of result.counters.validator_inputs) {
          assert.match(sent.body.input[0].content[0].text, /3\. Completeness\..*a longer duty list is expected to shrink to its main duties/s, label);
          assert.equal(sent.retry, false, label);
        }
        const fallback = !reviewer && lost;
        const calls = fallback && mode === "ENRICH" ? ["ENRICH", "MINIMAL"] : [mode];
        assert.deepEqual(result.counters.editor_calls, calls, label);
        assert.deepEqual(result.counters.validator_calls, calls, label);
        assert.equal(result.counters.eligibility_calls, 1, label);
        assert.deepEqual(result.counters.worker_calls, ["original_link", "project_link"], label);
        assert.equal(result.counters.persistence_updates, 1, label);
        assert.equal(result.state.raw.short_description, pair.short, label);
        assert.equal(result.state.eligibility_decision, decision.decision, label);
        if (reviewer) {
          assert.equal(result.update.processing_status, path === "REJECT" ? "REJECTED" : "NEEDS_REVIEW", label);
          assert.equal(result.update.final_description, "", label);
          // Section 15.1: content loss alone does not disqualify a validated candidate.
          assert.equal(result.update.draft_description, linked(body), label);
          assert.equal(result.state.final_editorial_mode, null, label);
          assert.deepEqual(plain(result.state.validation_history), [], label);
          assert.deepEqual(plain(result.state.reasons), decision.reasons, label);
          assert.equal(result.state.review_reason, decision.review_reason, label);
        } else {
          assert.equal(result.update.processing_status, "READY_FOR_PUBLISH", label);
          assert.equal(result.update.final_description, fallback ? linked(pair.short) : linked(body), label);
          assert.equal(result.update.draft_description, result.update.final_description, label);
          assert.equal(result.state.final_editorial_mode, fallback ? (mode === "ENRICH" ? "MINIMAL" : "KEEP") : mode, label);
          assert.deepEqual(plain(result.state.validation_history[0]), { attempt: 1, mode,
            decision: lost ? "FAIL" : "PASS", issues: lost ? ["MEANING_LOST"] : [] }, label);
          if (fallback && mode === "ENRICH") {
            assert.deepEqual(JSON.parse(result.counters.editor_inputs[1].body.input[1].content[0].text),
              { untrusted_source_data: { short_description: pair.short }, workflow_metadata: editorMetadata(pair.short) }, label);
          }
        }
      }
    }
  }
});

// Code-created Project Link and established material gaps. Mocked validator and
// eligibility findings below exercise the deterministic contracts, actual
// generated request payloads and routing only; they are not evidence that a
// live model identifies gaps correctly.
const INDEPENDENT_ENRICH_FAILURE = Object.freeze({ decision: "FAIL", issues: [{
  type: "UNSUPPORTED_FACT", text: "Преподаватель вместе с основателями студии развивает программу курса.",
  reason: "Mock independent failure that forces the existing fallback.",
}] });
const GAP_DECISION = Object.freeze({
  ...ACCEPT_KEEP, employer_name: "Студия «Тетрадь»", project_link_text: gapMention, editorial_mode: "ENRICH",
  editorial_reason: "The vacancy page describes the work the submission only names.",
  material_gaps: gapElements,
});
function gapFixture(layout = "prose", overrides = {}) {
  return {
    config: { max_llm_source_chars: 5000, max_extracted_chars: 10000 },
    readable_sources: ["original_link"],
    worker_responses: { original_link: workerSuccess(gapSourceLayouts[layout]) },
    eligibility_responses: [GAP_DECISION],
    editor_responses: {
      ENRICH: [{ draft_description: gapEnrichCandidate, project_link_text: gapMention, facts_added: gapEnrichFacts }],
      MINIMAL: [{ draft_description: gapMinimalCandidate, project_link_text: gapMention, facts_added: [] }],
    },
    ...overrides,
    row: { "Short Description": gapSubmission, "Project Website Link": gapProjectUrl, ...(overrides.row ?? {}) },
  };
}
const validatorPayload = (result, index = 0) => JSON.parse(result.counters.validator_inputs[index].body.input[1].content[0].text);

test("code-created link: the validator judges the editor's body; the wrapper and the selection are never validator input", async () => {
  const minimalDecision = { ...GAP_DECISION, editorial_mode: "MINIMAL", material_gaps: [] };
  for (const path of ["MINIMAL", "ENRICH", "reviewer"]) {
    const node = path === "MINIMAL" ? "MINIMAL" : "ENRICH";
    const candidate = path === "MINIMAL" ? gapMinimalCandidate : gapEnrichCandidate;
    const result = await runM6Fixture(gapFixture("prose", {
      eligibility_responses: [path === "MINIMAL" ? minimalDecision : path === "ENRICH" ? GAP_DECISION : { ...REVIEW_DECISION, project_link_text: gapMention }],
    }));
    const payload = validatorPayload(result);
    assert.deepEqual(Object.keys(payload), ["untrusted_validation_data"], path);
    assert.equal(payload.untrusted_validation_data.draft_description, candidate, path);
    assert.equal("project_link_text" in payload.untrusted_validation_data, false, path);
    assert.doesNotMatch(JSON.stringify(payload), /tetrad\.example/, path);
    assert.doesNotMatch(result.counters.validator_inputs[0].body.input[0].content[0].text, /code_created_project_link|project_link_text/, path);
    assert.deepEqual(result.counters.validator_calls, [node], path);
    assert.equal(result.update.draft_description, linked(candidate, gapMention, gapProjectUrl), path);
    assert.equal(result.update.processing_status, path === "reviewer" ? "NEEDS_REVIEW" : "READY_FOR_PUBLISH", path);
    assert.equal(result.update.final_description, path === "reviewer" ? "" : result.update.draft_description, path);
  }

  const minimal = (overrides) => runM6Fixture(gapFixture("prose", {
    worker_responses: undefined, eligibility_responses: [minimalDecision], ...overrides,
  }));
  // A model-written URL is rejected before insertion; the validator never sees it.
  const invented = await minimal({ editor_responses: { MINIMAL: [{ draft_description: gapMinimalCandidate + " Подробнее: " + gapProjectUrl, project_link_text: gapMention, facts_added: [] }] } });
  assert.deepEqual(plain(invented.state.validation_history[0].issues), ["FORBIDDEN_SOURCE_USAGE"]);
  assert.deepEqual(invented.counters.validator_calls, []);
  assert.equal(invented.update.final_editorial_mode, "KEEP");

  // An editor-written link grounded in the submission is the editor's own text.
  const withUrl = gapSubmission + " Сайт: " + gapProjectUrl;
  const ownDraft = gapMinimalCandidate.replace(gapMention, `[${gapMention}](${gapProjectUrl})`);
  const own = await minimal({
    row: { "Short Description": withUrl },
    editor_responses: { MINIMAL: [{ draft_description: ownDraft, project_link_text: gapMention, facts_added: [] }] },
  });
  assert.equal(validatorPayload(own).untrusted_validation_data.draft_description, ownDraft);
  assert.equal(own.update.final_editorial_mode, "MINIMAL");
});

test("material gaps: the eligibility contract admits only EMPLOYER, ROLE and WORK for ACCEPT with ENRICH", async () => {
  const { state } = await runFixture({ ...gapFixture(), stop_before_eligibility: true });
  const validate = (value, m4 = state) => executeCode("Validate Eligibility Decision", responseWithText(value), { "M4 Source Acquisition Complete": m4 });
  for (const gaps of [["WORK"], ["EMPLOYER", "ROLE", "WORK"], []]) {
    const envelope = await validate({ ...GAP_DECISION, material_gaps: gaps });
    assert.equal(envelope.contract_valid, true, envelope.contract_error);
    assert.deepEqual(plain(envelope.decision.material_gaps), gaps);
  }
  const unread = plain(state);
  for (const source of ["original_link", "project_link"]) unread.sources[source].status = "extraction_failed";
  for (const [label, value, m4] of [
    ["not an array", { ...GAP_DECISION, material_gaps: null }, state],
    ["missing field", Object.fromEntries(Object.entries(GAP_DECISION).filter(([key]) => key !== "material_gaps")), state],
    ["unknown element", { ...GAP_DECISION, material_gaps: ["AGE"] }, state],
    ["repeated element", { ...GAP_DECISION, material_gaps: ["WORK", "WORK"] }, state],
    ["retired quotation record", { ...GAP_DECISION, material_gaps: [{ detail: "WORK", source: "original_link", evidence: "Вести групповые занятия" }] }, state],
    ["KEEP", { ...GAP_DECISION, editorial_mode: "KEEP" }, state],
    ["MINIMAL", { ...GAP_DECISION, editorial_mode: "MINIMAL" }, state],
    ["REJECT", { ...SALES_DECISION, material_gaps: gapElements }, state],
    ["NEEDS_REVIEW", { ...REVIEW_DECISION, material_gaps: gapElements }, state],
    ["no approved link content", GAP_DECISION, unread],
  ]) {
    const envelope = await validate(value, m4);
    assert.equal(envelope.contract_valid, false, label);
    assert.equal(typeof envelope.contract_error, "string", label);
  }
  // The schema and prompt deliver the same boundary on the initial and retry calls.
  for (const name of ["Eligibility Decision", "Eligibility Contract Retry"]) {
    const request = evaluateJsonBody(name, { "M4 Source Acquisition Complete": state, "Validate Eligibility Decision": { raw_text: "{}", contract_error: "fixture" } });
    const schema = request.text.format.schema;
    assert.ok(schema.required.includes("material_gaps"), name);
    assert.deepEqual(schema.properties.material_gaps.items, { type: "string", enum: ["EMPLOYER", "ROLE", "WORK"] }, name);
    assert.match(request.input[0].content[0].text, /material_gaps: only for ACCEPT with ENRICH, list each sufficiency element/, name);
  }
});

test("material gaps: an invalid gap uses the existing retry, and a corrected empty list keeps legitimate fallback", async () => {
  const result = await runM6Fixture(gapFixture("prose", {
    eligibility_responses: [
      { ...GAP_DECISION, material_gaps: ["AGE"] },
      { ...GAP_DECISION, material_gaps: [] },
    ],
    validator_responses: { ENRICH: [INDEPENDENT_ENRICH_FAILURE], MINIMAL: [VALIDATION_PASS] },
  }));
  assert.equal(result.counters.eligibility_calls, 2);
  assert.equal(JSON.parse(result.counters.eligibility_inputs[1].input[1].content[0].text).contract_error,
    "material_gaps may contain only EMPLOYER, ROLE or WORK");
  assert.deepEqual(plain(result.state.material_gaps), []);
  assert.equal(result.update.processing_status, "READY_FOR_PUBLISH");
  assert.equal(result.update.final_editorial_mode, "MINIMAL");
  assert.equal(result.update.final_description, linked(gapMinimalCandidate, gapMention, gapProjectUrl));
});

test("material gaps: after ENRICH fails, MINIMAL and KEEP stay unpublished for unstructured and headed sources", async () => {
  for (const layout of Object.keys(gapSourceLayouts)) {
    const source = gapSourceLayouts[layout];
    const result = await runM6Fixture(gapFixture(layout, { validator_responses: { ENRICH: [INDEPENDENT_ENRICH_FAILURE] } }));
    assert.equal(result.update.processing_status, "NEEDS_REVIEW", layout);
    assert.equal(result.update.eligibility_decision, "ACCEPT", layout);
    assert.equal(result.update.initial_editorial_mode, "ENRICH", layout);
    assert.equal(result.update.final_editorial_mode, "", layout);
    assert.equal(result.update.final_description, "", layout);
    assert.equal(result.update.facts_added_json, "[]", layout);
    assert.deepEqual(plain(result.state.validation_history), [
      { attempt: 1, mode: "ENRICH", decision: "FAIL", issues: ["UNSUPPORTED_FACT"] },
      { attempt: 2, mode: "MINIMAL", decision: "FAIL", issues: ["MEANING_LOST"] },
      { attempt: 3, mode: "KEEP", decision: "FAIL", issues: ["MEANING_LOST"] },
    ], layout);
    assert.equal(result.update.review_reason, "Текст не прошёл проверку для автоматической публикации (MEANING_LOST). В заявке не хватает: суть работы; страница вакансии это сообщает", layout);
    // MINIMAL is still generated independently from the submission alone.
    assert.deepEqual(result.counters.editor_calls, ["ENRICH", "MINIMAL"], layout);
    assert.deepEqual(result.counters.validator_calls, ["ENRICH"], layout);
    const minimalRequest = result.counters.editor_inputs[1].body.input[1].content[0].text;
    assert.deepEqual(JSON.parse(minimalRequest), { untrusted_source_data: { short_description: gapSubmission }, workflow_metadata: editorMetadata(gapSubmission) }, layout);
    assert.doesNotMatch(minimalRequest, /5–9|импровизац|основател|material_gaps/, layout);
    // The accepted ENRICH editor and validator see which elements the post must state.
    assert.deepEqual(JSON.parse(result.counters.editor_inputs[0].body.input[1].content[0].text).workflow_metadata.material_gaps, gapElements, layout);
    assert.deepEqual(validatorPayload(result).untrusted_validation_data.material_gaps, gapElements, layout);
    assert.deepEqual(plain(result.state.material_gaps), gapElements, layout);
    assert.equal("material_gaps" in result.update, false, "transient finding adds no Sheet column");
    // Section 15.1: the failed candidates are not usable, so the submission is the working copy.
    assert.equal(result.update.draft_description, linked(gapSubmission, gapMention, gapProjectUrl), layout);
    assert.equal(result.update.project_link_text, gapMention, layout);
    assert.equal(result.update.original_link_context, source, layout);
    assert.deepEqual(result.rawBeforePersistence, plain(result.state.raw), layout);
    assert.equal(result.counters.persistence_updates, 1, layout);
  }
});

test("material gaps: without an established gap the same broad-topic candidates still fall back and publish", async () => {
  for (const layout of Object.keys(gapSourceLayouts)) {
    const improvementOnly = { ...GAP_DECISION, material_gaps: [] };
    // Identical page and candidate: the existing deterministic heuristics alone pass them.
    const minimal = await runM6Fixture(gapFixture(layout, {
      eligibility_responses: [improvementOnly],
      validator_responses: { ENRICH: [INDEPENDENT_ENRICH_FAILURE], MINIMAL: [VALIDATION_PASS] },
    }));
    assert.equal(minimal.update.processing_status, "READY_FOR_PUBLISH", layout);
    assert.equal(minimal.update.final_editorial_mode, "MINIMAL", layout);
    assert.equal(minimal.update.final_description, linked(gapMinimalCandidate, gapMention, gapProjectUrl), layout);
    assert.deepEqual(validatorPayload(minimal, 1).untrusted_validation_data.approved_external_context, {}, layout);
    assert.equal("material_gaps" in validatorPayload(minimal, 1).untrusted_validation_data, false, layout);
    const keep = await runM6Fixture(gapFixture(layout, {
      eligibility_responses: [improvementOnly],
      validator_responses: { ENRICH: [INDEPENDENT_ENRICH_FAILURE], MINIMAL: [{ decision: "FAIL", issues: [{ type: "MEANING_LOST", text: "Требуется опыт преподавания", reason: "Mock independent failure." }] }] },
    }));
    assert.equal(keep.update.processing_status, "READY_FOR_PUBLISH", layout);
    assert.equal(keep.update.final_editorial_mode, "KEEP", layout);
    assert.equal(keep.update.final_description, linked(gapSubmission, gapMention, gapProjectUrl), layout);

    // A sufficient short submission and its concise paraphrase remain publishable.
    const sufficient = { row: { "Short Description": sufficientSubmission } };
    const concise = await runM6Fixture(gapFixture(layout, { ...sufficient,
      eligibility_responses: [improvementOnly],
      editor_responses: { ENRICH: [{ draft_description: sufficientSubmission, project_link_text: gapMention, facts_added: [] }],
        MINIMAL: [{ draft_description: sufficientConcise, project_link_text: gapMention, facts_added: [] }] },
    }));
    assert.deepEqual(plain(concise.state.validation_history).map((entry) => [entry.mode, entry.decision]), [["ENRICH", "FAIL"], ["MINIMAL", "PASS"]], layout);
    assert.equal(concise.update.final_description, linked(sufficientConcise, gapMention, gapProjectUrl), layout);
    for (const mode of ["KEEP", "MINIMAL"]) {
      const initial = await runM6Fixture(gapFixture(layout, { ...sufficient,
        eligibility_responses: [{ ...improvementOnly, editorial_mode: mode }],
        editor_responses: { MINIMAL: [{ draft_description: sufficientConcise, project_link_text: gapMention, facts_added: [] }] },
      }));
      assert.equal(initial.update.processing_status, "READY_FOR_PUBLISH", `${layout}: ${mode}`);
      assert.equal(initial.update.final_editorial_mode, mode, `${layout}: ${mode}`);
    }
  }
});

test("material gaps: a covered gap publishes through ENRICH, an omitted one still blocks publication", async () => {
  for (const layout of Object.keys(gapSourceLayouts)) {
    const published = await runM6Fixture(gapFixture(layout));
    assert.equal(published.update.processing_status, "READY_FOR_PUBLISH", layout);
    assert.equal(published.update.final_editorial_mode, "ENRICH", layout);
    assert.equal(published.update.final_description, linked(gapEnrichCandidate, gapMention, gapProjectUrl), layout);
    assert.deepEqual(plain(published.state.facts_added), gapEnrichFacts, layout);
    const payload = validatorPayload(published);
    assert.deepEqual(payload.untrusted_validation_data.material_gaps, gapElements, layout);
    assert.deepEqual(payload.untrusted_validation_data.approved_external_context, { original_link: gapSourceLayouts[layout] }, layout);
    assert.match(published.counters.validator_inputs[0].body.input[0].content[0].text, /4\. Gaps\. For ENRICH, the draft states each element in material_gaps/, layout);

    const omitted = await runM6Fixture(gapFixture(layout, { validator_responses: { ENRICH: [{ decision: "FAIL", issues: [
      { type: "MEANING_LOST", text: "Студия «Тетрадь» ищет в команду преподавателя", reason: "Mock: what the work involves is absent." },
    ] }] } }));
    assert.equal(omitted.update.processing_status, "NEEDS_REVIEW", layout);
    assert.equal(omitted.update.final_description, "", layout);
    assert.deepEqual(plain(omitted.state.validation_history).map((entry) => entry.issues), [["MEANING_LOST"], ["MEANING_LOST"], ["MEANING_LOST"]], layout);
  }
});

test("material gaps: terminal persistence cannot publish a dropped gap", async () => {
  const ready = await runM6Fixture(gapFixture("prose", {
    eligibility_responses: [{ ...GAP_DECISION, material_gaps: [] }],
    validator_responses: { ENRICH: [INDEPENDENT_ENRICH_FAILURE], MINIMAL: [VALIDATION_PASS] },
  }));
  assert.equal(ready.update.final_editorial_mode, "MINIMAL");
  const forged = plain(ready.state);
  forged.material_gaps = gapElements;
  await assert.rejects(executeCode("Prepare Terminal Persistence", forged), /cannot drop an established material gap through fallback/);
});

// Intake Trigger (spec Section 4.1, D-025).
const intakeTrigger = JSON.parse(readFileSync(workflowPath.replace(/\.json$/, "-intake-trigger.json"), "utf8"));
const intakeNodes = new Map(intakeTrigger.nodes.map((node) => [node.name, node]));

function runIntakeCode(name, { mode = "production", added = [], rows = [], input = rows, located = [] }) {
  const sandbox = {
    ...N8N_2_37_10_NATIVE_GLOBALS,
    $execution: { mode },
    $input: { all: () => input.map((json) => ({ json })) },
    $: (nodeName) => {
      const output = { "Google Sheets Trigger": added, "Locate Added Rows": located }[nodeName];
      assert.ok(output, `unexpected node reference ${nodeName}`);
      return { all: () => output.map((json) => ({ json })), first: () => ({ json: output[0] }) };
    },
  };
  return new vm.Script(`(() => {\n${intakeNodes.get(name).parameters.jsCode}\n})()`).runInNewContext(sandbox);
}

const intakeRaw = (timestamp, extra = {}) => ({
  Timestamp: timestamp,
  "Short Description": "Teacher",
  "Project Website Link": "https://example.com/project",
  "Original Link": "https://example.com/vacancy",
  "Contact Info": "@teacher",
  ...extra,
});

test("Intake Trigger is inactive and calls Vacancy Intake once per located row, sequentially", () => {
  assert.equal(intakeTrigger.id, "edujobs-intake-trigger");
  assert.equal(intakeTrigger.name, "EduJobs v2 · Intake Trigger");
  assert.equal(intakeTrigger.active, false);
  const trigger = intakeNodes.get("Google Sheets Trigger");
  assert.equal(trigger.type, "n8n-nodes-base.googleSheetsTrigger");
  assert.equal(trigger.parameters.authentication, "serviceAccount");
  assert.equal(trigger.parameters.event, "rowAdded");
  assert.equal(trigger.parameters.documentId.value, "={{ $env.GOOGLE_SHEETS_DOCUMENT_ID }}");
  assert.equal(trigger.parameters.sheetName.value, "={{ $env.GOOGLE_SHEETS_SHEET_NAME }}");
  for (const name of ["Google Sheets Trigger", "Read Application Rows"]) {
    assert.deepEqual(intakeNodes.get(name).credentials.googleApi, {
      id: TEST_CREDENTIAL_ENVIRONMENT.N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID,
      name: TEST_CREDENTIAL_ENVIRONMENT.N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_NAME,
    });
  }
  const read = intakeNodes.get("Read Application Rows");
  assert.equal(read.parameters.operation, "read");
  assert.equal(read.executeOnce, true);
  const call = intakeNodes.get("Execute Vacancy Intake");
  assert.equal(call.parameters.workflowId.value, workflow.id);
  assert.equal(call.parameters.mode, "each");
  assert.equal(call.parameters.options.waitForSubWorkflow, true);
  assert.deepEqual(call.parameters.workflowInputs.value, { row_number: "={{ $json.row_number }}" });
  assert.equal(call.onError, "continueRegularOutput");
  const target = nodes.get("When Executed by Another Workflow");
  assert.deepEqual(target.parameters.workflowInputs.values, [{ name: "row_number", type: "number" }]);
  // No Sheet write, worker or LLM call in the Intake Trigger.
  assert.deepEqual(intakeTrigger.nodes.map((node) => node.type).sort(), [
    "n8n-nodes-base.code", "n8n-nodes-base.code", "n8n-nodes-base.executeWorkflow",
    "n8n-nodes-base.googleSheets", "n8n-nodes-base.googleSheetsTrigger",
  ]);
  assert.doesNotMatch(JSON.stringify(intakeTrigger), /REPLACE_WITH_|openai|content-worker/i);
});

test("Intake Trigger locates added rows by their raw columns among unprocessed rows", () => {
  const rows = [
    { row_number: 2, ...intakeRaw("01.10.2026 10:00:00"), application_id: "done" },
    { row_number: 3, ...intakeRaw("24.10.2026 09:00:00") },
    { row_number: 4, ...intakeRaw("24.10.2026 09:05:00", { "Contact Info": 79001234567 }) },
  ];
  const added = [intakeRaw("24.10.2026 09:00:00"), intakeRaw("24.10.2026 09:05:00", { "Contact Info": "79001234567" })];
  assert.deepEqual(plain(runIntakeCode("Locate Added Rows", { added, rows })), [
    { json: { row_number: 3, unlocated_rows: [] } },
    { json: { row_number: 4, unlocated_rows: [] } },
  ]);
});

test("Intake Trigger refuses manual runs and fails visibly for rows it cannot locate", () => {
  const rows = [
    { row_number: 2, ...intakeRaw("24.10.2026 09:00:00") },
    { row_number: 3, ...intakeRaw("24.10.2026 09:00:00") },
    { row_number: 4, ...intakeRaw("24.10.2026 09:10:00") },
  ];
  assert.throws(() => runIntakeCode("Locate Added Rows", { mode: "test", added: [intakeRaw("24.10.2026 09:10:00")], rows }), /only when activated/);
  assert.throws(() => runIntakeCode("Locate Added Rows", { added: [intakeRaw("24.10.2026 09:00:00")], rows }), /No added row could be located/);
  const partial = plain(runIntakeCode("Locate Added Rows", { added: [intakeRaw("24.10.2026 09:00:00"), intakeRaw("24.10.2026 09:10:00")], rows }));
  assert.deepEqual(partial.map((item) => item.json.row_number), [4]);
  assert.deepEqual(partial[0].json.unlocated_rows, [{ added_index: 0, timestamp: "24.10.2026 09:00:00", matches: [2, 3] }]);

  const located = partial.map((item) => item.json);
  assert.throws(() => runIntakeCode("Report Intake Result", { input: [{ processing_status: "READY_FOR_PUBLISH" }], located }), /Rows to process manually/);
  const clean = [{ row_number: 4, unlocated_rows: [] }];
  assert.throws(() => runIntakeCode("Report Intake Result", { input: [{ error: "Workflow is not active and cannot be executed." }], located: clean }), /Workflow is not active/);
  assert.deepEqual(plain(runIntakeCode("Report Intake Result", { input: [{}], located: clean })), [{ json: { processed_row_numbers: [4] } }]);
});
