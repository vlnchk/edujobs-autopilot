// Offline replay of Workflow A for prompt and model evaluation.
//
// The generated workflow JSON is executed node by node outside n8n, in the same
// vm sandbox the workflow tests use. Sheet rows and content-worker responses are
// replayed from a read-only copy of the n8n SQLite database; only OpenAI calls
// are live. Nothing is written to Google Sheets, n8n or the worker.
//
//   node n8n/eval-replay.mjs extract --db <copy.sqlite> --executions 486-533 --out .cache/eval/dataset.json
//   node --env-file=.env.eval n8n/eval-replay.mjs run --workflow <workflow.json> --dataset .cache/eval/dataset.json \
//        --label <name> [--model gpt-6-luna] [--repeats 5] [--rows 2,3] [--concurrency 4] [--effort validator=high]
//        [--config validator_reasoning_effort=high]
//   node n8n/eval-replay.mjs run ... --replay-saved   (no API calls: reproduces the saved executions)
//   node --env-file=.env.eval n8n/eval-replay.mjs cases --workflow <workflow.json> --dataset .cache/eval/dataset.json \
//        --cases n8n/eval-cases.mjs --label <name> [--model gpt-6-luna] [--repeats 5] [--only <regex>] [--contract v1|v2]
//   node n8n/eval-replay.mjs report .cache/eval/runs/<label>.json [...]
//   node n8n/eval-replay.mjs report-cases .cache/eval/cases/<label>.json [...]
//
// .env.eval (ignored by git) holds only OPENAI_API_KEY=... for these offline runs.
//
// The dataset holds real submissions and contacts; keep it under the ignored .cache/.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import vm from "node:vm";
import { visibleLength } from "../workflow-logic/publication-shape.mjs";

const OPENAI_URL = "https://api.openai.com/v1/responses";
const SHEET_READ_NODE = "Read Sheet Rows For Selection And Duplicates";
const TERMINAL_NODE = "Persist Terminal State";
const WORKER_NODES = { "Extract Original Link": "original_link", "Extract Project Link": "project_link" };
const MAX_NODE_RUNS = 400;
// USD per 1M tokens: input, cached input, output (developers.openai.com model pages).
const PRICES = { "gpt-6-luna": [0.10, 0.01, 0.50] };

// The same globals the workflow tests expose to Code nodes (n8n task runner natives).
const NATIVE_GLOBALS = {
  Buffer, setTimeout, setInterval, setImmediate, clearTimeout, clearInterval, clearImmediate,
  btoa, atob, TextDecoder, TextDecoderStream, TextEncoder, TextEncoderStream, FormData,
};

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) { options._.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) options[key] = true;
    else { options[key] = next; index += 1; }
  }
  return options;
}

function numberList(value) {
  if (!value) return null;
  return String(value).split(",").flatMap((part) => {
    const [from, to] = part.split("-").map(Number);
    return to ? Array.from({ length: to - from + 1 }, (_, offset) => from + offset) : [from];
  });
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// n8n stores execution data with the flatted serializer.
function parseFlatted(text) {
  const ignore = {};
  const input = JSON.parse(text, (_, value) => (typeof value === "string" ? new String(value) : value))
    .map((value) => (value instanceof String ? String(value) : value));
  const revive = (parsed, output) => {
    const lazy = [];
    for (const key of Object.keys(output)) {
      const value = output[key];
      if (!(value instanceof String)) continue;
      const target = input[value];
      if (typeof target === "object" && target !== null && !parsed.has(target)) {
        parsed.add(target);
        output[key] = ignore;
        lazy.push([key, target]);
      } else {
        output[key] = target;
      }
    }
    for (const [key, target] of lazy) output[key] = revive(parsed, target);
    return output;
  };
  return typeof input[0] === "object" && input[0] ? revive(new Set(), input[0]) : input[0];
}

function readExecution(db, id) {
  const raw = execFileSync("sqlite3", ["-readonly", db, `select data from execution_data where executionId=${Number(id)};`], { maxBuffer: 1 << 30 }).toString().trim();
  if (!raw) return null;
  const outputs = {};
  for (const [name, runs] of Object.entries(parseFlatted(raw).resultData.runData)) {
    const run = runs[runs.length - 1];
    outputs[name] = (run.data?.main ?? []).map((branch) => (branch ?? []).map((item) => item.json));
  }
  return outputs;
}

function extract(options) {
  const ids = numberList(options.executions);
  if (!options.db || !ids || !options.out) throw new Error("extract needs --db, --executions and --out");
  const dataset = { created: new Date().toISOString(), source_executions: ids, sheet_rows: null, rows: {}, executions: {} };
  for (const id of ids) {
    const outputs = readExecution(options.db, id);
    if (!outputs?.[SHEET_READ_NODE] || !outputs["Workflow Configuration"]) continue;
    const config = outputs["Workflow Configuration"][0][0];
    const row = Number(config.selected_row_number);
    const llm = {};
    for (const [name, branches] of Object.entries(outputs)) {
      if (branches[0]?.[0]?.object === "response") llm[name] = branches[0][0];
    }
    dataset.executions[id] = { row, config, llm, terminal: outputs["Prepare Terminal Persistence"]?.[0]?.[0] ?? null };
    dataset.sheet_rows = outputs[SHEET_READ_NODE][0];
    const entry = (dataset.rows[row] ??= { executions: [], worker: {} });
    entry.executions.push(id);
    const prepared = outputs["Prepare Selected Application"]?.[0]?.[0];
    for (const [node, source] of Object.entries(WORKER_NODES)) {
      if (!outputs[node]) continue;
      const branch = outputs[node].findIndex((items) => items.length > 0);
      // Later executions overwrite earlier ones, keyed by the URL that was fetched.
      entry.worker[`${source} ${prepared?.normalized?.[source]}`] = { branch, json: outputs[node][branch][0] };
    }
  }
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, JSON.stringify(dataset));
  console.log(`dataset: ${Object.keys(dataset.executions).length} executions, rows ${Object.keys(dataset.rows).join(", ")} -> ${options.out}`);
}

function accessor(outputs, current) {
  const items = (name) => {
    const branches = outputs.get(name);
    if (!branches) throw new Error(`${current}: no output for ${name}`);
    const branch = branches.find((list) => list.length > 0);
    if (!branch) throw new Error(`${current}: empty output for ${name}`);
    return branch;
  };
  return (name) => ({
    first: () => ({ json: clone(items(name)[0]) }),
    all: () => items(name).map((json) => ({ json: clone(json) })),
  });
}

function evaluateExpression(source, scope) {
  if (typeof source !== "string" || !source.startsWith("={{") || !source.endsWith("}}")) return source;
  return new vm.Script(source.slice(3, -2).trim()).runInNewContext({ ...NATIVE_GLOBALS, ...scope });
}

function roleOf(name) {
  if (name.startsWith("Source Requirement")) return "source_requirement";
  if (name.includes("Context")) return "context_selector";
  if (name.startsWith("Eligibility")) return "eligibility";
  if (name.includes("Editor")) return "editor";
  if (name.includes("Validator")) return "validator";
  return "other";
}

function responseText(response) {
  for (const output of response?.output ?? []) {
    for (const part of output.content ?? []) if (part.type === "output_text") return part.text;
  }
  return null;
}

async function callOpenAI(body, apiKey) {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);
    try {
      const response = await fetch(OPENAI_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (response.ok) return { ok: true, json: JSON.parse(text), attempts: attempt };
      lastError = `${response.status} - ${text.slice(0, 400)}`;
      // Transport-level retries only; the workflow's own contract retries stay in the graph.
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastError = String(error);
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
  return { ok: false, message: lastError };
}

async function runWorkflow(workflow, dataset, row, options) {
  const nodes = new Map(workflow.nodes.map((node) => [node.name, node]));
  const outputs = new Map();
  const savedExecution = dataset.executions[dataset.rows[row].executions.at(-1)];
  const config = {
    ...savedExecution.config,
    selected_row_number: row,
    runner_mode: false,
    execution_id: `eval-${options.label}-${row}`,
    ...(options.model ? {
      source_requirement_model: options.model,
      eligibility_model: options.model,
      editor_model: options.model,
      validator_model: options.model,
    } : {}),
    ...(options.config ?? {}),
  };
  const trace = { row, path: [], llm: [], terminal: null, error: null };
  const queue = [{ name: "Manual Trigger", input: [{}] }];
  let runs = 0;
  try {
    while (queue.length) {
      const { name, input } = queue.shift();
      if (++runs > MAX_NODE_RUNS) throw new Error("node run limit exceeded");
      const node = nodes.get(name);
      if (!node) throw new Error(`unknown node ${name}`);
      trace.path.push(name);
      if (name === TERMINAL_NODE) { trace.terminal = clone(input[0].json); break; }
      const $ = accessor(outputs, name);
      let branches;
      switch (node.type) {
        case "n8n-nodes-base.manualTrigger":
          branches = [[{}]];
          break;
        case "n8n-nodes-base.set":
          branches = [[clone(config)]];
          break;
        case "n8n-nodes-base.crypto":
          branches = [input.map((item) => ({ ...item.json, [node.parameters.dataPropertyName]: randomUUID() }))];
          break;
        case "n8n-nodes-base.googleSheets":
          if (name !== SHEET_READ_NODE) throw new Error(`unexpected Sheets node ${name}`);
          // Datasets extracted before 2026-10-24 carry the old raw column name.
          branches = [clone(dataset.sheet_rows).map(({ "Project Link": oldLink, ...row }) => (
            oldLink === undefined || "Project Website Link" in row ? row : { ...row, "Project Website Link": oldLink }))];
          break;
        case "n8n-nodes-base.code": {
          const sandbox = {
            ...NATIVE_GLOBALS,
            $input: { all: () => input.map((item) => ({ json: clone(item.json) })), first: () => ({ json: clone(input[0].json) }) },
            $,
          };
          const result = await new vm.Script(`(async () => {\n${node.parameters.jsCode}\n})()`).runInNewContext(sandbox);
          branches = [result.map((item) => clone(item.json))];
          break;
        }
        case "n8n-nodes-base.if": {
          const condition = node.parameters.conditions.conditions[0];
          const pass = [];
          const fail = [];
          for (const item of input) {
            const left = evaluateExpression(condition.leftValue, { $json: clone(item.json), $ });
            if (typeof left !== typeof condition.rightValue) throw new Error(`${name}: strict type mismatch (${typeof left})`);
            (left === condition.rightValue ? pass : fail).push(item.json);
          }
          branches = [pass, fail];
          break;
        }
        case "n8n-nodes-base.httpRequest": {
          if (WORKER_NODES[name]) {
            const source = WORKER_NODES[name];
            const { url } = JSON.parse(evaluateExpression(node.parameters.jsonBody, { $ }));
            const saved = dataset.rows[row].worker[`${source} ${url}`];
            if (!saved) throw new Error(`${name}: no saved worker response for ${url}`);
            branches = saved.branch === 0 ? [[clone(saved.json)], []] : [[], [clone(saved.json)]];
            break;
          }
          if (node.parameters.url !== OPENAI_URL) throw new Error(`unexpected HTTP node ${name}`);
          const body = JSON.parse(evaluateExpression(node.parameters.jsonBody, { $ }));
          const role = roleOf(name);
          if (options.effort?.[role]) body.reasoning = { ...(body.reasoning ?? {}), effort: options.effort[role] };
          const started = Date.now();
          let result;
          if (options.overrides?.[name] !== undefined) {
            const value = options.overrides[name];
            result = { ok: true, json: { object: "response", output: [{ content: [{ type: "output_text", text: typeof value === "string" ? value : JSON.stringify(value) }] }] }, override: true };
          } else if (options.replaySaved) {
            const saved = savedExecution.llm[name];
            if (!saved) throw new Error(`${name}: no saved response (path diverged from the saved execution)`);
            result = { ok: true, json: clone(saved) };
          } else {
            if (!options.apiKey) throw new Error(`${name}: live call needed but OPENAI_API_KEY is not set`);
            result = await callOpenAI(body, options.apiKey);
          }
          const usage = result.json?.usage ?? {};
          trace.llm.push({
            node: name, role, model: body.model, effort: body.reasoning?.effort ?? result.json?.reasoning?.effort ?? null,
            ms: Date.now() - started, ok: result.ok, attempts: result.attempts ?? 1, override: Boolean(result.override),
            input_tokens: usage.input_tokens ?? 0, cached_tokens: usage.input_tokens_details?.cached_tokens ?? 0,
            output_tokens: usage.output_tokens ?? 0, reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
            output_text: result.ok ? responseText(result.json) : null, error: result.ok ? null : result.message,
            ...(options.saveRequests ? { request: body } : {}),
          });
          if (result.ok) branches = [[result.json], []];
          else if (node.onError === "continueErrorOutput") branches = [[], [{ message: result.message }]];
          else throw new Error(`${name}: ${result.message}`);
          break;
        }
        default:
          throw new Error(`unsupported node type ${node.type} (${name})`);
      }
      outputs.set(name, branches);
      if (options.stopAfter?.test(name)) {
        trace.stopped = { node: name, json: clone(branches.find((list) => list.length)?.[0] ?? null) };
        break;
      }
      (workflow.connections[name]?.main ?? []).forEach((targets, index) => {
        if (!branches[index]?.length) return;
        for (const target of targets ?? []) queue.push({ name: target.node, input: branches[index].map((json) => ({ json })) });
      });
    }
  } catch (error) {
    trace.error = String(error?.stack ?? error);
  }
  return trace;
}

async function pool(tasks, concurrency, worker) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await worker(tasks[index], index);
    }
  }));
  return results;
}

// --config key=value,... overrides Workflow Configuration fields (for example validator_reasoning_effort=high).
function parseConfig(value) {
  if (!value || value === true) return null;
  return Object.fromEntries(String(value).split(",").map((pair) => pair.split("=")));
}

function parseEffort(value) {
  if (!value || value === true) return null;
  return Object.fromEntries(String(value).split(",").map((pair) => pair.split("=")));
}

async function run(options) {
  if (!options.workflow || !options.dataset || !options.label) throw new Error("run needs --workflow, --dataset and --label");
  const workflow = JSON.parse(readFileSync(options.workflow, "utf8"));
  const dataset = JSON.parse(readFileSync(options.dataset, "utf8"));
  const replaySaved = Boolean(options["replay-saved"]);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!replaySaved && !apiKey) throw new Error("OPENAI_API_KEY is not set (use node --env-file=.env.eval ...)");
  const rows = numberList(options.rows) ?? Object.keys(dataset.rows).map(Number).sort((a, b) => a - b);
  const repeats = Number(options.repeats ?? 1);
  const settings = {
    label: options.label, model: options.model ?? null, effort: parseEffort(options.effort), config: parseConfig(options.config),
    replaySaved, apiKey, saveRequests: Boolean(options["save-requests"]),
    overrides: options.overrides ? JSON.parse(readFileSync(options.overrides, "utf8")) : null,
    stopAfter: options["stop-after"] ? new RegExp(options["stop-after"]) : null,
  };
  settings.max_visible_chars = Number(dataset.executions[dataset.rows[rows[0]].executions.at(-1)].config.max_publication_description_chars);
  const tasks = rows.flatMap((row) => Array.from({ length: repeats }, (_, repeat) => ({ row, repeat })));
  const started = Date.now();
  const traces = await pool(tasks, Number(options.concurrency ?? 4), async ({ row, repeat }) => {
    const trace = await runWorkflow(workflow, dataset, row, settings);
    const t = trace.terminal;
    process.stdout.write(`row ${row}#${repeat + 1}: ${trace.error ? "EXECUTION_ERROR " + trace.error.split("\n")[0] : `${t.processing_status} ${t.primary_reason || ""} ${t.final_editorial_mode || ""} ${t.validation_history_json}`}\n`);
    return { ...trace, repeat };
  });
  const out = options.out ?? `.cache/eval/runs/${options.label}.json`;
  mkdirSync(dirname(out), { recursive: true });
  const { apiKey: _omit, ...recorded } = settings;
  writeFileSync(out, JSON.stringify({ settings: { ...recorded, workflow: options.workflow, dataset: options.dataset, rows, repeats }, seconds: Math.round((Date.now() - started) / 1000), traces }, null, 1));
  console.log(`saved ${traces.length} traces -> ${out}`);
  if (replaySaved) verifyReplay(dataset, traces);
}

// Self-check: replaying saved model responses through the same workflow must
// reproduce every saved terminal row, apart from the processing timestamp.
function verifyReplay(dataset, traces) {
  let mismatches = 0;
  for (const trace of traces) {
    const saved = dataset.executions[dataset.rows[trace.row].executions.at(-1)].terminal;
    const strip = (value) => ({ ...value, processed_at: null });
    const same = !trace.error && JSON.stringify(strip(trace.terminal)) === JSON.stringify(strip(saved));
    if (!same) {
      mismatches += 1;
      const fields = trace.terminal ? Object.keys(saved).filter((key) => key !== "processed_at" && JSON.stringify(saved[key]) !== JSON.stringify(trace.terminal[key])) : ["(no terminal)"];
      console.log(`REPLAY MISMATCH row ${trace.row}: ${trace.error ?? fields.join(", ")}`);
    }
  }
  console.log(mismatches ? `replay self-check FAILED for ${mismatches} row(s)` : `replay self-check PASS (${traces.length} rows reproduce their saved terminal state)`);
  if (mismatches) process.exitCode = 1;
}

// Fixed-candidate validator cases (n8n/eval-cases.mjs): earlier model outputs are
// replayed as overrides up to the first publication validation of one mode, and
// only the validator call is live. A deterministic failure is reported as DET_FAIL.
const CASE_STOP = /^(?:Apply (?:MINIMAL|ENRICH) Validation|Record (?:MINIMAL|ENRICH) Deterministic Failure|(?:MINIMAL|ENRICH) (?:Editor|Validator) (?:Contract|Integration) Error)$/;

async function runCases(options) {
  if (!options.workflow || !options.dataset || !options.cases || !options.label) throw new Error("cases needs --workflow, --dataset, --cases and --label");
  const workflow = JSON.parse(readFileSync(options.workflow, "utf8"));
  const dataset = JSON.parse(readFileSync(options.dataset, "utf8"));
  const apiKey = process.env.OPENAI_API_KEY;
  // --dry answers every validator with PASS: it checks case plumbing without API calls.
  const dry = Boolean(options.dry);
  if (!apiKey && !dry) throw new Error("OPENAI_API_KEY is not set (use node --env-file=.env.eval ...)");
  const { default: buildCases } = await import(new URL(options.cases, `file://${process.cwd()}/`).href);
  const only = options.only ? new RegExp(options.only) : null;
  const cases = buildCases(dataset, { contract: options.contract ?? "v1" }).filter((item) => !only || only.test(item.id));
  const repeats = Number(options.repeats ?? 5);
  const settings = { label: options.label, model: options.model ?? null, effort: parseEffort(options.effort), config: parseConfig(options.config), apiKey, stopAfter: CASE_STOP };
  const tasks = cases.flatMap((item) => Array.from({ length: repeats }, (_, repeat) => ({ item, repeat })));
  const started = Date.now();
  const results = await pool(tasks, Number(options.concurrency ?? 6), async ({ item, repeat }) => {
    const dryValidator = dry ? Object.fromEntries(["MINIMAL", "ENRICH"].map((mode) => [`${mode} Validator`, { decision: "PASS", issues: [] }])) : {};
    // Upstream classifier calls replay the case's source execution; editors come from the case.
    const inherited = Object.fromEntries(Object.entries(dataset.executions[item.source].llm)
      .filter(([node]) => !["editor", "validator"].includes(roleOf(node)))
      .map(([node, response]) => [node, responseText(response)]));
    const trace = await runWorkflow(workflow, dataset, item.row, { ...settings, overrides: { ...inherited, ...item.overrides, ...dryValidator } });
    const validator = trace.llm.filter((call) => call.role === "validator").at(-1);
    const history = trace.stopped?.json?.validation_history?.at(-1);
    let verdict = "ERROR";
    if (trace.error) verdict = "ERROR";
    else if (trace.stopped?.node.startsWith("Record")) verdict = "DET_FAIL";
    else if (history) verdict = history.decision;
    let issues = [];
    try { issues = JSON.parse(validator?.output_text ?? "{}").issues ?? []; } catch {}
    return { id: item.id, expect: item.expect, repeat, verdict, det_issues: trace.stopped?.node.startsWith("Record") ? history?.issues : null,
      issues: issues.map((issue) => ({ type: issue.type, text: issue.text, reason: issue.reason })), error: trace.error, llm: trace.llm };
  });
  const out = options.out ?? `.cache/eval/cases/${options.label}.json`;
  mkdirSync(dirname(out), { recursive: true });
  const { apiKey: _omit, stopAfter: _stop, ...recorded } = settings;
  writeFileSync(out, JSON.stringify({ settings: { ...recorded, workflow: options.workflow, cases: options.cases, repeats }, seconds: Math.round((Date.now() - started) / 1000), results }, null, 1));
  console.log(`saved ${results.length} case results -> ${out}`);
  reportCases([out]);
}

function reportCases(files) {
  for (const file of files) {
    const { settings, results, seconds } = JSON.parse(readFileSync(file, "utf8"));
    console.log(`\n=== cases ${settings.label}  model=${settings.model ?? "(config)"} effort=${JSON.stringify(settings.effort)} repeats=${settings.repeats} (${seconds}s)`);
    const byCase = new Map();
    for (const result of results) {
      if (!byCase.has(result.id)) byCase.set(result.id, []);
      byCase.get(result.id).push(result);
    }
    const score = { PASS: [0, 0], FAIL: [0, 0] };
    for (const [id, list] of byCase) {
      const expect = list[0].expect;
      const correct = list.filter((r) => (expect === "PASS" ? r.verdict === "PASS" : ["FAIL", "DET_FAIL"].includes(r.verdict))).length;
      score[expect][0] += correct;
      score[expect][1] += list.length;
      const counts = {};
      for (const r of list) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
      const types = [...new Set(list.flatMap((r) => r.issues.map((issue) => issue.type).concat(r.det_issues ?? [])))];
      console.log(`${correct === list.length ? "ok  " : "MISS"} ${id.padEnd(34)} expect ${expect.padEnd(4)} got ${Object.entries(counts).map(([k, v]) => `${v}x${k}`).join(" ")}${types.length ? "  [" + types.join(", ") + "]" : ""}`);
    }
    console.log(`good drafts passed: ${score.PASS[0]}/${score.PASS[1]}; bad drafts caught: ${score.FAIL[0]}/${score.FAIL[1]}`);
  }
}

function summarizeOutcome(trace) {
  if (trace.error) return "EXECUTION_ERROR";
  const t = trace.terminal;
  const history = JSON.parse(t.validation_history_json || "[]").map((entry) => entry.mode[0] + (entry.decision === "PASS" ? "+" : "-")).join(">");
  return [t.processing_status, t.primary_reason, t.final_editorial_mode, history].filter(Boolean).join(" ");
}

function report(files) {
  for (const file of files) {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const { traces, settings } = data;
    console.log(`\n=== ${settings.label}  model=${settings.model ?? "(config)"} effort=${JSON.stringify(settings.effort)} repeats=${settings.repeats} (${data.seconds}s)`);
    const byRow = new Map();
    for (const trace of traces) {
      if (!byRow.has(trace.row)) byRow.set(trace.row, []);
      byRow.get(trace.row).push(trace);
    }
    for (const [row, list] of [...byRow].sort((a, b) => a[0] - b[0])) {
      const counts = {};
      for (const trace of list) counts[summarizeOutcome(trace)] = (counts[summarizeOutcome(trace)] ?? 0) + 1;
      const lengths = list.filter((t) => t.terminal?.final_description).map((t) => visibleLength(t.terminal.final_description));
      console.log(`row ${String(row).padStart(2)}: ${Object.entries(counts).map(([key, count]) => `${count}x ${key}`).join(" | ")}${lengths.length ? `  final=${lengths.join("/")}` : ""}`);
    }
    const terminals = traces.filter((trace) => trace.terminal).map((trace) => trace.terminal);
    const status = (value) => terminals.filter((t) => t.processing_status === value).length;
    const finals = terminals.filter((t) => t.final_description).map((t) => visibleLength(t.final_description));
    const enrichFirst = traces.map((trace) => JSON.parse(trace.terminal?.validation_history_json || "[]")).filter((h) => h[0]?.mode === "ENRICH");
    const validators = traces.flatMap((trace) => trace.llm.filter((call) => call.role === "validator" && call.ok && !call.override));
    const issues = {};
    let fails = 0;
    for (const call of validators) {
      let parsed = null;
      try { parsed = JSON.parse(call.output_text); } catch { continue; }
      if (parsed.decision === "FAIL") fails += 1;
      for (const issue of parsed.issues ?? []) issues[issue.type] = (issues[issue.type] ?? 0) + 1;
    }
    const calls = traces.flatMap((trace) => trace.llm.filter((call) => !call.override));
    const sum = (key) => calls.reduce((total, call) => total + (call[key] ?? 0), 0);
    const price = PRICES[settings.model];
    const cost = price ? ((sum("input_tokens") - sum("cached_tokens")) * price[0] + sum("cached_tokens") * price[1] + sum("output_tokens") * price[2]) / 1e6 : null;
    console.log(`terminal: READY ${status("READY_FOR_PUBLISH")}, NEEDS_REVIEW ${status("NEEDS_REVIEW")}, REJECTED ${status("REJECTED")}, ERROR ${status("ERROR")}, execution errors ${traces.filter((t) => t.error).length} / ${traces.length}`);
    console.log(`ENRICH first pass: ${enrichFirst.filter((h) => h[0].decision === "PASS").length}/${enrichFirst.length}; validator FAIL ${fails}/${validators.length} ${JSON.stringify(issues)}`);
    const limit = settings.max_visible_chars;
    console.log(`final visible chars: max ${finals.length ? Math.max(...finals) : "-"}, over ${limit}: ${finals.filter((n) => n > limit).length}/${finals.length}`);
    console.log(`LLM calls ${calls.length}, input ${sum("input_tokens")} (cached ${sum("cached_tokens")}), output ${sum("output_tokens")} (reasoning ${sum("reasoning_tokens")})${cost === null ? "" : `, est. $${cost.toFixed(4)}`}`);
  }
}

const options = parseArgs(process.argv.slice(2));
const command = options._[0];
if (command === "extract") extract(options);
else if (command === "run") await run(options);
else if (command === "cases") await runCases(options);
else if (command === "report") report(options._.slice(1));
else if (command === "report-cases") reportCases(options._.slice(1));
else {
  console.error("usage: eval-replay.mjs extract|run|report (see the header comment)");
  process.exitCode = 2;
}
