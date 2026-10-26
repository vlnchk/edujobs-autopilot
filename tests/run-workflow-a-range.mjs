#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";


const WORKFLOW_ID = "edujobs-workflow-a";
const TERMINAL_STATUSES = new Set(["READY_FOR_PUBLISH", "REJECTED", "NEEDS_REVIEW", "ERROR"]);
const CONFIRMED_PRE_WRITE_FAILURE_NODES = new Set([
  "Workflow Configuration",
  "Generate Application UUID",
  "Read Sheet Rows For Selection And Duplicates",
  "Prepare Selected Application",
  "Prepare Terminal Persistence",
]);

export function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (!new Set(["start-row", "end-row"]).has(name)) throw new Error(`Unknown option: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    if (values.has(name)) throw new Error(`Duplicate option: ${argument}`);
    values.set(name, value);
    index += 1;
  }

  const startRow = Number(values.get("start-row"));
  const endRow = Number(values.get("end-row"));
  if (!Number.isInteger(startRow) || startRow < 2) throw new Error("--start-row must be an integer >= 2");
  if (!Number.isInteger(endRow) || endRow < startRow) {
    throw new Error("--end-row must be an integer >= --start-row");
  }
  return { startRow, endRow };
}

function nodeOutputs(payload, nodeName) {
  const tasks = payload?.data?.resultData?.runData?.[nodeName];
  if (!Array.isArray(tasks)) return [];
  return tasks.flatMap((task) => Array.isArray(task?.data?.main) ? task.data.main.flat() : [])
    .map((item) => item?.json).filter(Boolean);
}

export function parseN8nOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const starts = [...text.matchAll(/(?:^|\n)([\[{])/g)].map((match) => match.index + (match[0].startsWith("\n") ? 1 : 0));
    for (const start of starts.reverse()) {
      try {
        return JSON.parse(text.slice(start));
      } catch {
        // Ignore non-JSON log prefixes and try the previous candidate.
      }
    }
    return null;
  }
}

export function classifyExecution(rowNumber, payload, processStatus, diagnostic = "") {
  const runnerResult = nodeOutputs(payload, "Build Runner Result").at(-1);
  if (runnerResult?.runner_result === true) {
    const modifiedRows = Array.isArray(runnerResult.modified_rows)
      ? runnerResult.modified_rows.map(Number).filter(Number.isInteger)
      : null;
    const exactRowInvariant = modifiedRows !== null
      && modifiedRows.length === 1
      && modifiedRows[0] === rowNumber
      && runnerResult.invariant_ok === true;
    const terminalStatus = String(runnerResult.terminal_status || "UNKNOWN");
    const terminal = TERMINAL_STATUSES.has(terminalStatus);
    const passed = processStatus === 0 && terminal && exactRowInvariant;
    let result = String(runnerResult.reason || terminalStatus);
    if (!exactRowInvariant) {
      result = modifiedRows === null
        ? "ROW INVARIANT FAILED: modified rows unavailable"
        : `ROW INVARIANT FAILED: expected [${rowNumber}], observed [${modifiedRows.join(", ")}]`;
    } else if (!terminal) {
      result = `Non-terminal workflow status: ${terminalStatus}`;
    }
    return {
      rowNumber,
      executionId: String(runnerResult.execution_id || "-"),
      terminalStatus,
      modifiedRows,
      passed,
      result,
      stop: !exactRowInvariant,
      lengths: Object.fromEntries(["input_chars", "draft_chars", "final_chars"].map((name) => [
        name, Number.isInteger(runnerResult[name]) && runnerResult[name] >= 0 ? runnerResult[name] : null,
      ])),
    };
  }

  const resultData = payload?.data?.resultData;
  const runData = resultData?.runData;
  const configuration = nodeOutputs(payload, "Workflow Configuration").at(-1);
  const persisted = nodeOutputs(payload, "Prepare Terminal Persistence").at(-1);
  const persistenceStarted = (runData?.["Persist Terminal State"]?.length ?? 0) > 0;
  const executionError = resultData?.error;
  const failedNode = executionError?.node?.name;
  const noWriteConfirmed = runData && typeof runData === "object" && !Array.isArray(runData)
    && executionError && CONFIRMED_PRE_WRITE_FAILURE_NODES.has(failedNode)
    && resultData.lastNodeExecuted === failedNode
    && !Object.hasOwn(runData, "Persist Terminal State");
  const terminalStatus = persisted?.processing_status
    ? String(persisted.processing_status)
    : "EXECUTION_FAILED";
  const failureText = [executionError?.message, diagnostic].filter(Boolean).join("; ")
    || "n8n execution did not return a runner result";
  return {
    rowNumber,
    executionId: String(configuration?.execution_id || "-"),
    terminalStatus,
    modifiedRows: noWriteConfirmed ? [] : null,
    passed: false,
    result: noWriteConfirmed
      ? `No Sheet write: confirmed failure at ${failedNode}; ${failureText}`
      : persistenceStarted
        ? `VERIFICATION FAILED AFTER SHEET UPDATE: ${failureText}`
        : `Sheet write UNKNOWN: ${failureText}`,
    stop: !noWriteConfirmed,
  };
}

// Keeps only what classifyExecution reads from saved run data, so the recovery
// query prints a few kilobytes. Embedded in the container script by toString(),
// so it must stay self-contained.
export function compactSavedExecution(executionData) {
  const resultData = executionData?.resultData ?? {};
  const runData = resultData.runData && typeof resultData.runData === "object" ? resultData.runData : {};
  const kept = {
    "Workflow Configuration": ["execution_id", "selected_row_number", "runner_mode"],
    "Prepare Terminal Persistence": ["processing_status"],
    "Build Runner Result": null,
  };
  const pick = (name, json) => kept[name] === null
    ? json
    : Object.fromEntries(kept[name].filter((key) => json && Object.hasOwn(json, key)).map((key) => [key, json[key]]));
  const compactRunData = Object.fromEntries(Object.entries(runData).map(([name, tasks]) => [
    name,
    (Array.isArray(tasks) ? tasks : []).map((task) => Object.hasOwn(kept, name)
      ? { data: { main: (task?.data?.main ?? []).map((branch) => (branch ?? []).map((item) => ({ json: pick(name, item?.json) }))) } }
      : {}),
  ]));
  const error = resultData.error
    ? { message: resultData.error.message, node: resultData.error.node ? { name: resultData.error.node.name } : undefined }
    : undefined;
  return { data: { resultData: { runData: compactRunData, error, lastNodeExecuted: resultData.lastNodeExecuted } } };
}

// Read-only SQLite access through the n8n image; the runner has stopped n8n, so
// only the child it started can have created executions after the baseline.
export function savedExecutionScript() {
  return `const r = require("node:module").createRequire("/usr/local/lib/node_modules/n8n/package.json");
const sqlite = r("sqlite3");
const flatted = r("flatted");
${compactSavedExecution.toString()}
const db = new sqlite.Database("/home/node/.n8n/database.sqlite", sqlite.OPEN_READONLY);
const finish = (error, value) => {
  db.close();
  if (error) { console.error(error.message); process.exitCode = 1; return; }
  process.stdout.write(JSON.stringify(value) + "\\n");
};
if (process.env.RUNNER_QUERY === "latest") {
  db.get("SELECT MAX(id) AS id FROM execution_entity", [], (error, row) => finish(error, { latest: Number(row?.id ?? 0) }));
} else {
  db.all(
    "SELECT e.id, e.workflowId, e.status, d.data FROM execution_entity e LEFT JOIN execution_data d ON d.executionId = e.id WHERE e.id > ? ORDER BY e.id",
    [Number(process.env.RUNNER_AFTER_EXECUTION_ID)],
    (error, rows) => finish(error, rows && { executions: rows.map((row) => ({
      id: String(row.id),
      workflow_id: row.workflowId,
      status: row.status,
      payload: row.data ? compactSavedExecution(flatted.parse(row.data)) : null,
    })) }),
  );
}`;
}

// Runs one row; when stdout is lost, verifies the write from the execution the
// child saved instead of guessing. Anything ambiguous stays UNKNOWN.
export async function executeRow(rowNumber, { runChild, latestExecutionId, savedExecutionsAfter }) {
  let baseline = null;
  let baselineFailure = null;
  try {
    baseline = latestExecutionId();
  } catch (error) {
    baselineFailure = error.message;
  }
  const execution = runChild(rowNumber);
  let payload = parseN8nOutput(execution.stdout);
  const diagnostics = [
    `child exit ${execution.status ?? "unknown"}${execution.error ? ` (${execution.error.message})` : ""}`,
    execution.stderr && `stderr: ${oneLine(execution.stderr)}`,
    execution.stdout && `stdout: ${oneLine(execution.stdout)}`,
  ];
  let recoveredId = null;
  if (!payload?.data?.resultData) {
    diagnostics.push(`stdout (${String(execution.stdout ?? "").length} chars) has no parseable run result`);
    if (baseline === null) {
      diagnostics.push(`saved-execution recovery unavailable: ${baselineFailure}`);
    } else {
      try {
        const saved = savedExecutionsAfter(baseline);
        const [candidate] = saved;
        const configuration = nodeOutputs(candidate?.payload, "Workflow Configuration").at(-1);
        if (saved.length === 1 && candidate.workflow_id === WORKFLOW_ID
          && configuration?.runner_mode === true && Number(configuration?.selected_row_number) === rowNumber) {
          payload = candidate.payload;
          recoveredId = candidate.id;
          diagnostics.push(`result read from saved execution ${candidate.id} (${candidate.status})`);
        } else {
          diagnostics.push(`saved-execution recovery found ${saved.length} new execution(s) without a single matching row ${rowNumber} run`);
        }
      } catch (error) {
        diagnostics.push(`saved-execution recovery failed: ${error.message}`);
      }
    }
  }
  const result = classifyExecution(rowNumber, payload, execution.status, diagnostics.filter(Boolean).join("; "));
  if (recoveredId !== null && result.passed) result.result += ` (stdout lost; verified from saved execution ${recoveredId})`;
  return result;
}

export async function runSequential(startRow, endRow, executeRow) {
  const results = [];
  for (let rowNumber = startRow; rowNumber <= endRow; rowNumber += 1) {
    const result = await executeRow(rowNumber);
    results.push(result);
    if (result.stop) break;
  }
  return results;
}

function runCompose(args, options = {}) {
  return spawnSync("docker", ["compose", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });
}

function requireSuccess(result, label) {
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `${label} exited ${result.status}`).trim();
    throw new Error(`${label} failed: ${detail}`);
  }
}

function querySavedExecutions(environment) {
  const result = runCompose([
    "run", "--rm", "--no-deps", "-T",
    ...Object.entries(environment).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    "--entrypoint", "node", "n8n", "-e", savedExecutionScript(),
  ]);
  requireSuccess(result, "saved-execution query");
  const parsed = parseN8nOutput(result.stdout);
  if (!parsed) throw new Error("saved-execution query returned no JSON");
  return parsed;
}

function oneLine(value, maxLength = 180) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function printTable(results) {
  const rows = results.map((result) => ({
    row: String(result.rowNumber),
    execution: result.executionId,
    terminal: result.terminalStatus,
    status: result.passed ? "PASS" : "FAIL",
    modified_rows: result.modifiedRows === null ? "UNKNOWN" : `[${result.modifiedRows.join(",")}]`,
    input_chars: String(result.lengths?.input_chars ?? "-"),
    draft_chars: String(result.lengths?.draft_chars ?? "-"),
    final_chars: String(result.lengths?.final_chars ?? "-"),
    result: oneLine(result.result),
  }));
  const headers = ["row", "execution", "terminal", "status", "modified_rows", "input_chars", "draft_chars", "final_chars", "result"];
  const widths = Object.fromEntries(headers.map((header) => [
    header,
    Math.max(header.length, ...rows.map((row) => row[header].length)),
  ]));
  const line = (row) => headers.map((header) => row[header].padEnd(widths[header])).join(" | ");
  console.log("\n" + line(Object.fromEntries(headers.map((header) => [header, header]))));
  console.log(headers.map((header) => "-".repeat(widths[header])).join("-+-"));
  for (const row of rows) console.log(line(row));
  const passed = results.filter((result) => result.passed).length;
  console.log(`\nTested: ${results.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${results.length - passed}`);
}

async function main() {
  const { startRow, endRow } = parseArguments(process.argv.slice(2));
  const serviceResult = runCompose(["ps", "--status", "running", "--services"]);
  requireSuccess(serviceResult, "docker compose ps");
  const runningServices = new Set(serviceResult.stdout.split(/\s+/).filter(Boolean));
  for (const required of ["browserless", "content-worker"]) {
    if (!runningServices.has(required)) {
      throw new Error(`${required} must be running; start the sandbox with: docker compose up -d --wait`);
    }
  }

  const restartN8n = runningServices.has("n8n");
  if (restartN8n) requireSuccess(runCompose(["stop", "n8n"]), "stopping n8n for exclusive SQLite access");

  let results;
  try {
    results = await runSequential(startRow, endRow, async (rowNumber) => {
      process.stdout.write(`Executing Workflow A for row ${rowNumber}... `);
      const result = await executeRow(rowNumber, {
        runChild: () => runCompose([
          "run", "--rm", "--no-deps",
          "-e", `WORKFLOW_A_RUNNER_ROW_NUMBER=${rowNumber}`,
          "n8n", "execute", `--id=${WORKFLOW_ID}`, "--rawOutput",
        ]),
        latestExecutionId: () => {
          const { latest } = querySavedExecutions({ RUNNER_QUERY: "latest" });
          if (!Number.isInteger(latest)) throw new Error("saved-execution query returned no latest id");
          return latest;
        },
        savedExecutionsAfter: (id) => {
          const { executions } = querySavedExecutions({ RUNNER_QUERY: "after", RUNNER_AFTER_EXECUTION_ID: id });
          if (!Array.isArray(executions)) throw new Error("saved-execution query returned no executions list");
          return executions;
        },
      });
      console.log(result.passed ? "PASS" : "FAIL");
      if (result.stop) console.error("Stopping: row-write isolation could not be proven; continuing could corrupt additional test rows.");
      return result;
    });
  } finally {
    if (restartN8n) {
      const restart = runCompose(["up", "-d", "--wait", "n8n"]);
      if (restart.status !== 0) console.error(`Warning: n8n restart failed: ${oneLine(restart.stderr || restart.stdout)}`);
    }
  }

  printTable(results);
  if (results.some((result) => !result.passed)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
