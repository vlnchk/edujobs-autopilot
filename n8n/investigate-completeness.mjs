import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import {
  mergedCandidate, splitCandidate, completeReference, conciseSource,
  conciseCandidate, noisyContexts,
} from "./completeness-fixtures.mjs";

// Regression for the confirmed severe-collapse exemption. Exercise the shared
// generated helper once; distinct routing/fallback effects live in workflow-a.test.
export function verifyCompletenessGrouping(workflow) {
  const code = (name) => workflow.nodes.find((node) => node.name === name).parameters.jsCode;
  const minimal = code("Deterministic MINIMAL Output Check");
  const helpers = minimal.slice(minimal.indexOf("const MEANING_STOP_WORDS"), minimal.indexOf("\nconst issues = []")).trim();
  for (const name of ["Apply Eligibility Decision", "Deterministic ENRICH Output Check", "Validate Deterministic KEEP", "Prepare Reviewer Draft", "Prepare Terminal Persistence"]) {
    assert.ok(code(name).includes(helpers), `${name}: same shared completeness helper`);
  }
  const metrics = vm.runInNewContext(`${helpers}
    (source, draft) => {
      const sourceTokens = meaningTokens(source), draftTokens = meaningTokens(draft);
      const sourceCategories = meaningCategories(source), draftCategories = meaningCategories(draft);
      const unique = new Set(sourceTokens);
      return {
        sourceTokens: sourceTokens.length, draftTokens: draftTokens.length,
        sourceUnits: meaningUnits(source).length, draftUnits: meaningUnits(draft).length,
        sourceCategories: sourceCategories.size, draftCategories: draftCategories.size,
        preservedCategories: [...sourceCategories].filter(category => draftCategories.has(category)).length,
        lexicalCoverage: new Set(draftTokens.filter(token => unique.has(token))).size / unique.size,
        lost: meaningWasObviouslyLost(source, draft),
      };
    }
  `);
  const normalize = value => value.replace(/\s+/g, " ").trim();
  const results = [];
  const baseline = metrics(completeReference, mergedCandidate);
  // Include several paragraph boundaries; keep the reference byte-for-byte fixed.
  for (const candidate of [mergedCandidate, splitCandidate, mergedCandidate.replaceAll(" learners ", "\n\nlearners ").replace(" focused ", "\nfocused ")]) {
    assert.equal(normalize(candidate), mergedCandidate, "identical words, punctuation, facts and order");
    assert.deepEqual(candidate.match(/\S+/g), mergedCandidate.match(/\S+/g));
    const measured = metrics(completeReference, candidate);
    for (const field of ["sourceTokens", "draftTokens", "sourceUnits", "sourceCategories", "draftCategories", "preservedCategories", "lexicalCoverage"]) {
      assert.equal(measured[field], baseline[field], `${field}: candidate formatting cannot change content metrics`);
    }
    assert.equal(measured.lost, true, JSON.stringify(measured));
    results.push(measured);
  }
  assert.deepEqual(results.map(item => item.draftUnits), [1, 2, 3]);
  // Sentence punctuation also creates units; adding only whitespace cannot
  // rescue an incomplete multi-sentence candidate either.
  const sentenceCandidate = mergedCandidate.replace(" algebra through ", " algebra. Through ");
  for (const candidate of [sentenceCandidate, sentenceCandidate.replace(". Through", ".\n\nThrough")]) {
    assert.equal(normalize(candidate), sentenceCandidate);
    assert.equal(metrics(completeReference, candidate).draftUnits, 2);
    assert.equal(metrics(completeReference, candidate).lost, true);
  }
  // Full-content, faithful concision/paraphrase, short hiring and noise removal.
  for (const [source, draft] of [
    [completeReference, completeReference],
    [conciseSource, conciseCandidate],
    [mergedCandidate, mergedCandidate],
    ["Example Academy is hiring a teacher for remote evening classes.", "Example Academy is hiring a teacher for remote evening classes."],
    ["Home\nMenu\nPrivacy policy\n" + conciseSource + "\nSubscribe", conciseCandidate],
  ]) {
    const merged = normalize(draft);
    const split = merged.replace(/ /, "\n\n");
    for (const variant of [draft, merged, split]) {
      assert.equal(normalize(variant), merged);
      assert.equal(metrics(source, variant).lost, false, JSON.stringify(metrics(source, variant)));
    }
  }
  for (const source of noisyContexts) {
    for (const candidate of [mergedCandidate, splitCandidate]) {
      assert.equal(metrics(source, candidate).lost, false, "noisy source cannot imply missing vacancy content");
    }
  }
  return { results, complete_concise_paraphrase_short_noise_controls: "PASS" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.argv[2], "usage: node n8n/investigate-completeness.mjs WORKFLOW_JSON");
  console.log(JSON.stringify(verifyCompletenessGrouping(JSON.parse(readFileSync(process.argv[2], "utf8"))), null, 2));
}
