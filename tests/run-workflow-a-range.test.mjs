import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  classifyExecution,
  compactSavedExecution,
  executeRow,
  parseArguments,
  parseN8nOutput,
  runSequential,
  savedExecutionScript,
} from "./run-workflow-a-range.mjs";


function payloadWith(outputs, error = null, lastNodeExecuted = null) {
  const runData = Object.fromEntries(Object.entries(outputs).map(([name, json]) => [name, [{
    data: { main: [[{ json }]] },
  }]]));
  return { data: { resultData: { runData, error, lastNodeExecuted } } };
}

test("range arguments require an ordered inclusive data-row range", () => {
  assert.deepEqual(parseArguments(["--start-row", "2", "--end-row", "21"]), { startRow: 2, endRow: 21 });
  assert.throws(() => parseArguments(["--start-row", "1", "--end-row", "2"]), />= 2/);
  assert.throws(() => parseArguments(["--start-row", "4", "--end-row", "3"]), />= --start-row/);
  assert.throws(() => parseArguments(["--start-row", "2"]), /--end-row/);
});

test("n8n output parser accepts raw JSON and a preceding Compose log line", () => {
  assert.deepEqual(parseN8nOutput('{"ok":true}'), { ok: true });
  assert.deepEqual(parseN8nOutput('compose note\n{"ok":true}'), { ok: true });
  assert.equal(parseN8nOutput(""), null);
  assert.equal(parseN8nOutput(null), null);
  assert.equal(parseN8nOutput("not json"), null);
});

test("empty or damaged child output keeps the write UNKNOWN and stops before another row", async () => {
  const visited = [];
  for (const stdout of ["", null, '{"data":', "not json", "{}", '{"data":{"resultData":{"runData":{"Workflow Configuration":{}}}}}']) {
    const results = await runSequential(6, 7, async (rowNumber) => {
      visited.push(rowNumber);
      return classifyExecution(rowNumber, parseN8nOutput(stdout), 1, "child exit 1; stderr: container exited");
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].executionId, "-");
    assert.equal(results[0].modifiedRows, null);
    assert.equal(results[0].stop, true);
    assert.equal(results[0].passed, false);
    assert.match(results[0].result, /^Sheet write UNKNOWN:.*child exit 1.*container exited/);
  }
  assert.deepEqual(visited, [6, 6, 6, 6, 6, 6]);
});

test("a zero-exit child with missing output is still UNKNOWN, as in execution 149", () => {
  const result = classifyExecution(6, parseN8nOutput(""), 0, "child exit 0; stdout unavailable");
  assert.equal(result.modifiedRows, null);
  assert.equal(result.stop, true);
  assert.equal(result.passed, false);
  assert.match(result.result, /^Sheet write UNKNOWN:.*child exit 0/);
});

test("a log prefix before valid JSON retains the runner result", () => {
  const payload = payloadWith({ "Build Runner Result": {
    runner_result: true, execution_id: "149", terminal_status: "REJECTED",
    modified_rows: [6], invariant_ok: true,
  } });
  const parsed = parseN8nOutput(`compose note\n${JSON.stringify(payload)}`);
  const result = classifyExecution(6, parsed, 0);
  assert.equal(result.executionId, "149");
  assert.equal(result.passed, true);
  assert.equal(result.stop, false);
});

test("successful terminal execution passes only for the exact requested row", () => {
  const payload = payloadWith({
    "Build Runner Result": {
      runner_result: true,
      row_number: 3,
      execution_id: "123",
      terminal_status: "REJECTED",
      reason: "SALES",
      modified_rows: [3],
      invariant_ok: true,
    },
  });
  assert.deepEqual(classifyExecution(3, payload, 0), {
    rowNumber: 3,
    executionId: "123",
    terminalStatus: "REJECTED",
    modifiedRows: [3],
    passed: true,
    result: "SALES",
    stop: false,
    lengths: { input_chars: null, draft_chars: null, final_chars: null },
  });
});

test("unexpected application-row modification fails prominently and stops the range", () => {
  const payload = payloadWith({
    "Build Runner Result": {
      runner_result: true,
      execution_id: "124",
      terminal_status: "READY_FOR_PUBLISH",
      modified_rows: [5],
      invariant_ok: false,
    },
  });
  const result = classifyExecution(4, payload, 0);
  assert.equal(result.passed, false);
  assert.equal(result.stop, true);
  assert.match(result.result, /ROW INVARIANT FAILED.*expected \[4\].*observed \[5\]/);
});

test("failure before persistence records no write and permits the next row", () => {
  const payload = payloadWith({
    "Workflow Configuration": { execution_id: "125" },
  }, {
    message: "selected row was not found",
    node: { name: "Read Sheet Rows For Selection And Duplicates" },
  }, "Read Sheet Rows For Selection And Duplicates");
  const result = classifyExecution(7, payload, 1);
  assert.deepEqual(result.modifiedRows, []);
  assert.equal(result.stop, false);
  assert.match(result.result, /^No Sheet write:/);
});

test("missing pre-write failure evidence does not establish that no write occurred", () => {
  const payload = payloadWith({
    "Workflow Configuration": { execution_id: "125" },
  }, { message: "selected row was not found" });
  const result = classifyExecution(7, payload, 1);
  assert.equal(result.modifiedRows, null);
  assert.equal(result.stop, true);
  assert.match(result.result, /^Sheet write UNKNOWN:/);
});

test("failure after persistence is unverifiable and stops to protect test data", () => {
  const payload = payloadWith({
    "Workflow Configuration": { execution_id: "126" },
    "Prepare Terminal Persistence": { processing_status: "ERROR" },
    "Persist Terminal State": { row_number: 8 },
  }, { message: "verification read failed" });
  const result = classifyExecution(8, payload, 1);
  assert.equal(result.modifiedRows, null);
  assert.equal(result.stop, true);
  assert.match(result.result, /^VERIFICATION FAILED AFTER SHEET UPDATE:/);
});

test("completed persistence without a runner verification result stops as unverifiable", () => {
  const payload = payloadWith({
    "Workflow Configuration": { execution_id: "149" },
    "Prepare Terminal Persistence": { processing_status: "REJECTED" },
    "Persist Terminal State": { row_number: 6 },
  });
  const result = classifyExecution(6, payload, 0, "child exit 0; stdout: verification missing");
  assert.equal(result.executionId, "149");
  assert.equal(result.modifiedRows, null);
  assert.equal(result.stop, true);
  assert.match(result.result, /^VERIFICATION FAILED AFTER SHEET UPDATE:.*verification missing/);
});

test("range execution is sequential and continues after ordinary row failure", async () => {
  let active = 0;
  let maxActive = 0;
  const visited = [];
  const results = await runSequential(2, 4, async (rowNumber) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    visited.push(rowNumber);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return { rowNumber, passed: rowNumber !== 3, stop: false };
  });
  assert.deepEqual(visited, [2, 3, 4]);
  assert.equal(maxActive, 1);
  assert.equal(results.length, 3);
});


test("length diagnostics never change the terminal or row-isolation verdict", () => {
  const payload = payloadWith({ "Build Runner Result": {
    runner_result: true, terminal_status: "READY_FOR_PUBLISH", modified_rows: [3], invariant_ok: true,
    input_chars: 5000, draft_chars: 1800, final_chars: 1800,
  } });
  const result = classifyExecution(3, payload, 0);
  assert.equal(result.passed, true);
  assert.deepEqual(result.lengths, { input_chars: 5000, draft_chars: 1800, final_chars: 1800 });
  payload.data.resultData.runData["Build Runner Result"][0].data.main[0][0].json.modified_rows = [4];
  assert.equal(classifyExecution(3, payload, 0).passed, false);
});


// Saved run data as n8n stores it: every executed node, large state items.
function savedRun(rowNumber, { runner = true, persistError = null, failedBeforeWrite = null } = {}) {
  const bulky = { draft_description: "текст ".repeat(5000), sources: { original_link: { used_context: "x".repeat(20000) } } };
  const outputs = {
    "Workflow Configuration": { execution_id: "450", selected_row_number: rowNumber, runner_mode: true, editor_model: "model" },
    "Prepare Selected Application": bulky,
  };
  if (!failedBeforeWrite) {
    outputs["Prepare Terminal Persistence"] = { ...bulky, processing_status: "READY_FOR_PUBLISH" };
    outputs["Persist Terminal State"] = { row_number: rowNumber };
  }
  if (runner && !persistError && !failedBeforeWrite) {
    outputs["Build Runner Result"] = {
      runner_result: true, row_number: rowNumber, execution_id: "450", terminal_status: "READY_FOR_PUBLISH",
      reason: "READY_FOR_PUBLISH", modified_rows: [rowNumber], invariant_ok: true, input_chars: 70, draft_chars: 381, final_chars: 381,
    };
  }
  const error = persistError
    ? { message: persistError, node: { name: "Persist Terminal State", parameters: bulky } }
    : failedBeforeWrite ? { message: "selected row was not found", node: { name: failedBeforeWrite } } : undefined;
  const lastNodeExecuted = persistError ? "Persist Terminal State" : failedBeforeWrite ?? "Build Runner Result";
  return {
    startData: {},
    resultData: {
      runData: Object.fromEntries(Object.entries(outputs).map(([name, json]) => [name, [{ startTime: 1, source: [], data: { main: [[{ json, pairedItem: { item: 0 } }]] } }]])),
      error,
      lastNodeExecuted,
    },
    executionData: { nodeExecutionStack: [], waitingExecution: {} },
  };
}

test("compact saved execution keeps every field the classifier reads and drops the rest", () => {
  for (const options of [{}, { persistError: "The connection to the server was closed unexpectedly" }, { failedBeforeWrite: "Read Sheet Rows For Selection And Duplicates" }]) {
    const full = savedRun(11, options);
    const compact = compactSavedExecution(full);
    assert.deepEqual(classifyExecution(11, compact, 0, "d"), classifyExecution(11, { data: full }, 0, "d"), JSON.stringify(options));
    assert.ok(JSON.stringify(compact).length < 2000, JSON.stringify(options));
  }
  assert.deepEqual(compactSavedExecution(null), { data: { resultData: { runData: {}, error: undefined, lastNodeExecuted: undefined } } });
});

test("the container query is read-only and embeds a self-contained compactor", () => {
  const script = savedExecutionScript();
  assert.match(script, /sqlite\.OPEN_READONLY/);
  assert.doesNotMatch(script, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE)\b/i);
  const isolated = vm.runInNewContext(`(${compactSavedExecution.toString()})`, { Object, Array });
  const full = savedRun(11);
  assert.deepEqual(JSON.parse(JSON.stringify(isolated(full))), JSON.parse(JSON.stringify(compactSavedExecution(full))));
});

const truncatedStdout = 'Failed to load Custom API options for the node "n8n-nodes-base.confluence"\n{\n  "data": {\n    "startData": {},\n    "resultData": {\n      "runData": {';

function rowHarness({ stdout = truncatedStdout, status = 0, saved = [], latest = () => 449 } = {}) {
  const calls = { savedAfter: [] };
  return {
    calls,
    dependencies: {
      runChild: () => ({ status, stdout, stderr: "Container vers_2-n8n-run-1 Created" }),
      latestExecutionId: latest,
      savedExecutionsAfter: (id) => {
        calls.savedAfter.push(id);
        if (saved instanceof Error) throw saved;
        return saved;
      },
    },
  };
}

const savedRecord = (rowNumber, options = {}, overrides = {}) => ({
  id: "450", workflow_id: "edujobs-workflow-a", status: options.persistError ? "error" : "success",
  payload: compactSavedExecution(savedRun(rowNumber, options)), ...overrides,
});

test("parseable stdout never triggers saved-execution recovery", async () => {
  const payload = compactSavedExecution(savedRun(11));
  const { calls, dependencies } = rowHarness({ stdout: `note\n${JSON.stringify(payload)}`, saved: [savedRecord(11)] });
  const result = await executeRow(11, dependencies);
  assert.equal(result.passed, true);
  assert.equal(result.result, "READY_FOR_PUBLISH");
  assert.deepEqual(calls.savedAfter, []);
});

test("truncated stdout is verified from the single saved execution of that row (execution 450)", async () => {
  const { calls, dependencies } = rowHarness({ saved: [savedRecord(11)] });
  const result = await executeRow(11, dependencies);
  assert.deepEqual(calls.savedAfter, [449]);
  assert.equal(result.passed, true);
  assert.equal(result.stop, false);
  assert.equal(result.executionId, "450");
  assert.deepEqual(result.modifiedRows, [11]);
  assert.deepEqual(result.lengths, { input_chars: 70, draft_chars: 381, final_chars: 381 });
  assert.equal(result.result, "READY_FOR_PUBLISH (stdout lost; verified from saved execution 450)");
});

test("a lost Sheet write is reported from saved data and still stops the range (execution 460)", async () => {
  const { dependencies } = rowHarness({ status: 1, saved: [savedRecord(20, { persistError: "The connection to the server was closed unexpectedly" })] });
  const result = await executeRow(20, dependencies);
  assert.equal(result.passed, false);
  assert.equal(result.stop, true);
  assert.equal(result.modifiedRows, null);
  assert.equal(result.terminalStatus, "READY_FOR_PUBLISH");
  assert.match(result.result, /^VERIFICATION FAILED AFTER SHEET UPDATE: The connection to the server was closed unexpectedly;.*result read from saved execution 450 \(error\)/);
});

test("recovery never guesses: ambiguous, foreign or unavailable saved data stays UNKNOWN", async () => {
  const cases = [
    ["no saved execution", { saved: [] }, /found 0 new execution/],
    ["two saved executions", { saved: [savedRecord(11), savedRecord(11, {}, { id: "451" })] }, /found 2 new execution/],
    ["another row", { saved: [savedRecord(12)] }, /without a single matching row 11 run/],
    ["another workflow", { saved: [savedRecord(11, {}, { workflow_id: "other" })] }, /without a single matching row 11 run/],
    ["no saved data", { saved: [savedRecord(11, {}, { payload: null })] }, /without a single matching row 11 run/],
    ["query failure", { saved: new Error("sqlite busy") }, /recovery failed: sqlite busy/],
    ["baseline failure", { latest: () => { throw new Error("docker unavailable"); } }, /recovery unavailable: docker unavailable/],
  ];
  for (const [label, options, diagnostic] of cases) {
    const { calls, dependencies } = rowHarness(options);
    const result = await executeRow(11, dependencies);
    assert.equal(result.passed, false, label);
    assert.equal(result.stop, true, label);
    assert.equal(result.modifiedRows, null, label);
    assert.match(result.result, /^Sheet write UNKNOWN:.*child exit 0.*stdout \(\d+ chars\) has no parseable run result/, label);
    assert.match(result.result, diagnostic, label);
    if (label === "baseline failure") assert.deepEqual(calls.savedAfter, [], label);
  }
});

test("a recovered run still fails when the child exited non-zero", async () => {
  const { dependencies } = rowHarness({ status: 1, saved: [savedRecord(11)] });
  const result = await executeRow(11, dependencies);
  assert.equal(result.passed, false);
  assert.deepEqual(result.modifiedRows, [11]);
  assert.equal(result.result, "READY_FOR_PUBLISH");
});
