import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { vacancyContext, noisyContexts, conciseSource, conciseCandidate } from "./completeness-fixtures.mjs";

// Synthetic only. No saved application text, employer exception or live access.
export const noisyEmployerContext = [
  "Home | News | Admissions | Library | Events | Contact",
  "Student experience and library opening hours are listed in the visitor schedule.",
  "News: our team organizes public lectures and prepares the annual museum exhibition.",
  "Events: the university will host a festival of student societies and an international conference.",
  "About company: the institution has forty buildings, twelve campuses and thousands of students.",
  "About project: the annual report lists awards, scholarship totals and international rankings.",
  "Research collections include manuscripts, scientific journals, archaeological objects and historical maps.",
  "Visitor information includes exhibition dates, ticket reservations, directions and reception contacts.",
].join("\n\n");
export const sparseTitle = "Digital services specialist at Example University";

// Section 13.10: code may force ENRICH only for a bare title or announcement
// whose approved vacancy page explicitly describes the work. Page volume,
// employer noise, Project Link content or a sufficient submission never force it.
export async function verifySourceNoiseOverride(workflow) {
  const code = workflow.nodes.find(node => node.name === "Apply Eligibility Decision").parameters.jsCode;
  const singleFacets = [
    "Responsibilities: develop accessible learning materials for adult students across introductory mathematics courses. Coordinate weekly teaching sessions with academic mentors and subject specialists. Prepare individual feedback and review learning progress across practical classroom exercises.",
    "Requirements: relevant teaching experience with adult learners across introductory mathematics courses is essential. Knowledge of accessible educational materials and inclusive assessment practices is required. Candidates need strong communication skills and familiarity with digital learning tools.",
    "Conditions: remote employment with regular evening classes and a flexible weekly schedule. The written contract includes preparation hours and weekly planning meetings with academic mentors. Paid holidays and professional development allowances are included in the compensation package.",
  ];
  const decision = { decision: "ACCEPT", primary_reason: null, reasons: [], evidence: [], review_reason: null,
    role_title: null, employer_name: null, project_link_text: "Example University",
    editorial_mode: "MINIMAL", editorial_reason: "No additional material role information." };
  const input = (context, submission = sparseTitle, source = "original_link") => ({
    state: {
      normalized: { short_description: submission },
      // Isolates the Section 13.10 override from the Section 13.1 budget gate.
      m4: { max_publication_description_chars: Number.MAX_SAFE_INTEGER },
      source_requirement: { [source + "_required"]: true },
      sources: { [source]: { status: "success", relation: "RELEVANT", used_context: context } },
    }, decision: structuredClone(decision),
  });
  const run = async envelope => {
    const before = structuredClone(envelope);
    const output = (await vm.runInNewContext(`(async () => { ${code} })()`, {
      $input: { first: () => ({ json: envelope }) },
    }))[0].json;
    assert.deepEqual(envelope, before, "the input envelope and its evidence remain unchanged");
    const result = JSON.parse(JSON.stringify(output));
    assert.deepEqual(result.sources, before.state.sources, "used_context is preserved verbatim");
    assert.deepEqual(result.eligibility_evidence, before.decision.evidence);
    return result;
  };
  const cases = [
    ...[noisyEmployerContext, ...noisyContexts].map(context => [context, sparseTitle, false]),
    [vacancyContext, sparseTitle, true],
    [singleFacets[0], sparseTitle, true],
    [singleFacets[1], sparseTitle, false],
    [singleFacets[2], sparseTitle, false],
    [noisyEmployerContext + "\n" + vacancyContext, sparseTitle, true],
    [vacancyContext.replaceAll(": ", ":\n"), sparseTitle, true],
    // Any explicit duties on the vacancy page can complete a bare title.
    [noisyEmployerContext + "\nResponsibilities: teach classes.", sparseTitle, true],
    // A sufficient submission is never forced, however rich the page is.
    [vacancyContext, vacancyContext, false],
    [vacancyContext, conciseSource, false],
    [vacancyContext, conciseCandidate, false],
    // Unstructured or project-style prose needs semantic judgment.
    ["Our project develops accessible lessons with educators and disability advocates. It serves adult learners using assistive technology and provides resources adapted to their learning needs.", sparseTitle, false],
  ];
  for (const [context, submission, forced] of cases) {
    for (const mode of ["KEEP", "MINIMAL"]) {
      const envelope = input(context, submission);
      envelope.decision.editorial_mode = mode;
      const result = await run(envelope);
      assert.equal(result.editorial_mode, forced ? "ENRICH" : mode, `${mode}: ${submission.slice(0, 40)} / ${context.slice(0, 60)}`);
      assert.equal(result.editorial_reason, forced ? "The Short Description is only a title or fragment; approved vacancy context can supply what the work involves." : decision.editorial_reason);
      assert.equal(result.processing_status, "PROCESSING");
    }
  }
  // A semantic ENRICH is never downgraded.
  const semantic = input(noisyEmployerContext);
  semantic.decision.editorial_mode = "ENRICH";
  assert.equal((await run(semantic)).editorial_mode, "ENRICH");
  // Project Link content, and unapproved Original Link content, never force ENRICH.
  // A successfully read non-required page is approved (Stage 3), so it is not excluded.
  assert.equal((await run(input(vacancyContext, sparseTitle, "project_link"))).editorial_mode, "MINIMAL", "project_link");
  for (const excluded of ["failed", "irrelevant", "disputed"]) {
    const envelope = input(vacancyContext);
    if (excluded === "failed") envelope.state.sources.original_link.status = "extraction_failed";
    if (excluded === "irrelevant") envelope.state.sources.original_link.relation = "NO_USEFUL_CONTENT";
    if (excluded === "disputed") envelope.decision.evidence = [{ source: "original_link", reason: "WRONG_LINK_TARGET", text: "Unrelated content." }];
    assert.equal((await run(envelope)).editorial_mode, "MINIMAL", excluded);
  }
  return { override_cases: cases.length * 2, mode_source_and_immutability_checks: "PASS" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.argv[2], "usage: node n8n/investigate-source-noise.mjs WORKFLOW_JSON");
  console.log(JSON.stringify(await verifySourceNoiseOverride(JSON.parse(readFileSync(process.argv[2], "utf8")))));
}
