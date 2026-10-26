// Fixed-candidate validator cases for `eval-replay.mjs cases`.
//
// Each case replays the saved classifier responses of its source execution and a
// saved (or deliberately corrupted) editor response for one dataset row, so only
// the validator call is live. "PASS" cases are faithful drafts that an earlier validator run failed or
// passed; "FAIL" cases contain one injected defect that publication must stop.
// Execution numbers refer to the 2026-10-06 runs 486–533 in the eval dataset.

function outputText(response) {
  for (const output of response?.output ?? []) {
    for (const part of output.content ?? []) if (part.type === "output_text") return part.text;
  }
  throw new Error("saved response has no output_text");
}

export default function buildCases(dataset, { contract = "v1" } = {}) {
  const saved = (execution, node) => {
    const response = dataset.executions[execution]?.llm?.[node];
    if (!response) throw new Error(`dataset lacks ${node} of execution ${execution}`);
    return JSON.parse(outputText(response));
  };
  // The v2 contract records material gaps as the missing sufficiency elements only.
  const gapElement = (detail) => (/организ|проект|employer|organization|project/i.test(detail) ? "EMPLOYER"
    : /роль|должност|role/i.test(detail) ? "ROLE" : "WORK");
  const eligibility = (execution, change = (value) => value) => {
    const value = change(saved(execution, "Eligibility Decision"));
    if (contract === "v2") value.material_gaps = [...new Set(value.material_gaps.map((gap) => gapElement(gap.detail)))];
    return value;
  };
  const replace = (text, from, to) => {
    if (!text.includes(from)) throw new Error(`case mutation source not found: ${from}`);
    return text.replace(from, to);
  };
  const draft = (execution, node, change = (value) => value) => change(saved(execution, node));
  const asMode = (mode) => (value) => ({ ...value, editorial_mode: mode, editorial_reason: `Evaluation case routed to ${mode}.`, material_gaps: [] });

  const good = (id, row, execution, node, note, options = {}) => ({
    id, row, expect: "PASS", note, source: options.eligibility ?? execution,
    overrides: {
      "Eligibility Decision": eligibility(options.eligibility ?? execution, options.route),
      [node]: draft(execution, node),
    },
  });
  const bad = (id, row, execution, node, note, change, options = {}) => ({
    id, row, expect: "FAIL", note, source: options.eligibility ?? execution,
    overrides: {
      "Eligibility Decision": eligibility(options.eligibility ?? execution, options.route),
      [node]: draft(execution, node, change),
    },
  });

  return [
    // Faithful drafts. The first five were failed by the validator in runs 486–533.
    good("good/r6-gap-covered-by-duties", 6, 526, "ENRICH Editor", "«what the work involves» is covered by the duty list; the quoted goal sentence is not required"),
    good("good/r3-employer-page-quote", 3, 523, "ENRICH Editor", "a quotation from the employer's own page describes the employer without repeating its name"),
    good("good/r5-secondary-requirement", 5, 513, "ENRICH Editor", "duties are stated, so «знаком с креативным сектором» may stay behind the details link"),
    good("good/r12-minimal-requirements", 12, 520, "MINIMAL Editor", "requirements may stay behind the details link; «со знанием английского» is the author's wording", { route: asMode("MINIMAL") }),
    good("good/r9-evaluative-schedule", 9, 493, "ENRICH Editor", "«комфортный график» states no schedule, so the page's 5/2 replaces it"),
    good("good/r6-run502", 6, 502, "ENRICH Editor", "same row, earlier faithful candidate"),
    good("good/r9-run529", 9, 529, "ENRICH Editor", "faithful ENRICH"),
    good("good/r10-run530", 10, 530, "ENRICH Editor", "faithful ENRICH that adds the employer"),
    good("good/r11-run531", 11, 531, "ENRICH Editor", "faithful ENRICH of a short submission"),
    good("good/r12-run532", 12, 532, "ENRICH Editor", "faithful ENRICH"),
    good("good/r4-minimal-run524", 4, 524, "MINIMAL Editor", "faithful MINIMAL shortening of a 2928-character submission"),

    // One injected defect each; publication must stop.
    bad("bad/r3-inferred-office-format", 3, 487, "ENRICH Editor", "«очный формат работы» is inferred from «очные курсы» (real editor error, execution 487)", (value) => value),
    bad("bad/r9-salary-changed", 9, 529, "ENRICH Editor", "submitted salary 100 → 150 тыс.", (value) => ({ ...value, draft_description: replace(value.draft_description, "от 100 тыс. руб.", "от 150 тыс. руб.") })),
    bad("bad/r9-salary-dropped", 9, 529, "ENRICH Editor", "submitted salary removed", (value) => ({ ...value, draft_description: replace(value.draft_description, "— зарплата от 100 тыс. руб. + премии до 30%;\n", "") })),
    bad("bad/r9-experience-changed", 9, 529, "ENRICH Editor", "submitted experience 1 → 3 years", (value) => ({ ...value, draft_description: replace(value.draft_description, "опыт от 1 года", "опыт от 3 лет") })),
    bad("bad/r12-invented-pay", 12, 532, "ENRICH Editor", "pay amount invented", (value) => ({ ...value, draft_description: replace(value.draft_description, "Оплата обсуждается на собеседовании.", "Оплата — 40 000 рублей за смену.") })),
    bad("bad/r11-experience-reversed", 11, 531, "ENRICH Editor", "«Опыт работы не требуется» reversed", (value) => ({ ...value, draft_description: replace(value.draft_description, "Опыт работы не требуется.", "Требуется опыт работы от 3 лет.") })),
    bad("bad/r4-minimal-external-fact", 4, 524, "MINIMAL Editor", "MINIMAL adds an unsubmitted workload", (value) => ({ ...value, draft_description: replace(value.draft_description, "Удалённая работа.", "Удалённая работа, полная занятость — 40 часов в неделю.") })),
    bad("bad/r10-application-instruction", 10, 530, "ENRICH Editor", "excluded application instruction without a contact pattern", (value) => ({ ...value, draft_description: value.draft_description + "\n\nЧтобы откликнуться, пришлите резюме и пару слов о себе в личные сообщения." })),
    bad("bad/r12-unrecorded-page-claim", 12, 532, "ENRICH Editor", "page claim added without a facts_added record", (value) => ({ ...value, draft_description: replace(value.draft_description, "Оплата обсуждается на собеседовании.", "Рабочий день — с 8:30 до 18:00. Оплата обсуждается на собеседовании.") })),
    bad("bad/r6-gap-not-covered", 6, 526, "ENRICH Editor", "duty list removed, so the recorded «what the work involves» gap stays open", (value) => {
      const start = value.draft_description.indexOf("Задачи:");
      const end = value.draft_description.indexOf("Место работы:");
      if (start < 0 || end < 0) throw new Error("case mutation source not found: Задачи block");
      return {
        ...value,
        draft_description: value.draft_description.slice(0, start) + value.draft_description.slice(end),
        facts_added: value.facts_added.filter((fact) => !/вебинар|портал|коммуникац/i.test(fact.fact)),
      };
    }),
  ];
}
