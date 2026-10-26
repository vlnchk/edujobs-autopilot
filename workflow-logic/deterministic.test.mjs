import assert from "node:assert/strict";
import test from "node:test";

import {
  findExactDuplicate,
  inspectSubmittedLink,
  inspectUrl,
  isSharedGenericRecruitingUrl,
  normalizeContactInfo,
  normalizeForExactComparison,
  normalizeStructuredText,
  prepareApplication,
  submittedLinkUrlCandidate,
} from "./deterministic.mjs";


const VALID_ROW = Object.freeze({
  row_number: 3,
  Timestamp: "2026-09-04 10:00",
  "Short Description": "Teach adults.",
  "Project Website Link": "https://example.com/project",
  "Original Link": "https://example.com/jobs/1",
  "Contact Info": "jobs@example.com",
});


function prepare(overrides = {}, existing = []) {
  return prepareApplication(
    { ...VALID_ROW, ...overrides },
    existing,
    () => "00000000-0000-4000-8000-000000000001",
  );
}


test("intake preserves raw fields, normalizes derived values, and generates an id", () => {
  const row = {
    ...VALID_ROW,
    "Short Description": "  First line \r\n\r\n  Second\tline  ",
    "Project Website Link": " HTTPS://Example.COM:443/project#team ",
  };

  const result = prepareApplication(
    row,
    [],
    () => "00000000-0000-4000-8000-000000000001",
  );

  assert.deepEqual(result.raw, {
    timestamp: row.Timestamp,
    short_description: row["Short Description"],
    project_link: row["Project Website Link"],
    original_link: row["Original Link"],
    contact_info: row["Contact Info"],
  });
  assert.equal(result.application_id, "00000000-0000-4000-8000-000000000001");
  assert.equal(result.normalized.short_description, "First line\n\nSecond line");
  assert.equal(result.normalized.project_link, "https://example.com/project");
  assert.equal(result.processing_status, "PROCESSING");
});


test("manual re-run preserves an existing application id", () => {
  const result = prepare({ application_id: "existing-id" });
  assert.equal(result.application_id, "existing-id");
});


test("default application id generation produces a UUID", () => {
  const result = prepareApplication(VALID_ROW);
  assert.match(
    result.application_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});


test("Project Link normalization accepts absolute URLs, Markdown links, and bare domains", () => {
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
    ["[any link text](https://example.com/path)", "https://example.com/path"],
  ]);

  for (const [input, expected] of cases) {
    const result = inspectSubmittedLink(input);
    assert.equal(result.valid, true, input);
    assert.equal(result.normalized, expected, input);
  }
});


test("Project Link normalization rejects non-domain text and embedded domains", () => {
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
    assert.equal(inspectSubmittedLink(input).valid, false, JSON.stringify(input));
  }
});


test("Markdown Project Link regression extracts its destination and avoids NO_PROJECT_LINK", () => {
  const input = "[leaguesofcode.com](http://leaguesofcode.com)";
  assert.equal(submittedLinkUrlCandidate(input), "http://leaguesofcode.com");
  assert.equal(inspectSubmittedLink(input).normalized, "http://leaguesofcode.com/");

  const result = prepare({ "Project Website Link": input });
  assert.equal(result.raw.project_link, input);
  assert.equal(result.normalized.project_link, "http://leaguesofcode.com/");
  assert.equal(result.processing_status, "PROCESSING");
  assert.equal(result.primary_reason, null);
  assert.equal(result.reasons.includes("NO_PROJECT_LINK"), false);
});


test("missing or malformed Project Link rejects as NO_PROJECT_LINK", () => {
  for (const projectLink of ["", "not a url", "ftp://example.com/project"]) {
    const result = prepare({ "Project Website Link": projectLink });
    assert.equal(result.processing_status, "REJECTED");
    assert.equal(result.eligibility_decision, "REJECT");
    assert.equal(result.primary_reason, "NO_PROJECT_LINK");
    assert.deepEqual(result.reasons, ["NO_PROJECT_LINK"]);
    assert.equal(result.eligibility_evidence[0].reason, "NO_PROJECT_LINK");
    assert.equal(result.eligibility_evidence[0].source, "project_link");
    assert.equal(result.review_reason, null);
    assert.equal(result.editorial_mode, null);
    assert.equal(result.editorial_reason, null);
  }
});


test("malformed Original Link rejects as LINK_BROKEN because it is the published details link", () => {
  const result = prepare({ "Original Link": "not a url" });

  assert.deepEqual(result.source_annotations.original_link, {
    missing: false,
    malformed: true,
    unsupported_social: false,
  });
  assert.equal(result.processing_status, "REJECTED");
  assert.equal(result.primary_reason, "LINK_BROKEN");
  assert.deepEqual(result.eligibility_evidence, [{ reason: "LINK_BROKEN", source: "original_link", text: "not a url" }]);
  // A malformed Project Link keeps its more specific code.
  assert.equal(prepare({ "Project Website Link": "not a url", "Original Link": "not a url" }).primary_reason, "NO_PROJECT_LINK");
});


test("Original Link shares the bare-domain and Markdown representation rules", () => {
  // Execution 452: a scheme-less Google Doc was annotated malformed and, once
  // required, rejected as LINK_BROKEN without being fetched.
  const bareDoc = "docs.google.com/document/d/1R9OJFVn4g27Q4_zHadhPqjVFGczWVsGfKMsZAZqhKII";
  const cases = new Map([
    [bareDoc, `https://${bareDoc}`],
    ["hh.ru/vacancy/130391042", "https://hh.ru/vacancy/130391042"],
    ["[Вакансия](https://hh.ru/vacancy/130391042)", "https://hh.ru/vacancy/130391042"],
  ]);
  for (const [input, expected] of cases) {
    const result = prepare({ "Original Link": input });
    assert.equal(result.raw.original_link, input);
    assert.equal(result.normalized.original_link, expected, input);
    assert.deepEqual(result.source_annotations.original_link, { missing: false, malformed: false, unsupported_social: false }, input);
  }
  for (const input of ["not a url", "Details: docs.google.com/document/d/abc", "ftp://example.com/job"]) {
    assert.equal(prepare({ "Original Link": input }).source_annotations.original_link.malformed, true, input);
  }
  assert.equal(prepare({ "Original Link": "t.me/vacancy_channel" }).source_annotations.original_link.unsupported_social, true);
  // Duplicate comparison sees the same canonical URL on both sides.
  const duplicate = prepare({ "Original Link": "example.com/jobs/1" }, [{ ...VALID_ROW, row_number: 2, application_id: "previous-id" }]);
  assert.equal(duplicate.duplicate.match, "ORIGINAL_LINK");
});


test("social source URLs are annotated without premature rejection", () => {
  const original = prepare({ "Original Link": "https://t.me/vacancy_channel" });
  const project = prepare({ "Project Website Link": "https://www.linkedin.com/company/example" });

  assert.equal(original.source_annotations.original_link.unsupported_social, true);
  assert.equal(original.processing_status, "PROCESSING");
  assert.equal(project.source_annotations.project_link.unsupported_social, true);
  assert.equal(project.processing_status, "PROCESSING");
});


test("site, form, or name without a direct contact rejects as NO_VALID_CONTACT", () => {
  const result = prepare({
    "Contact Info": "Alex Example, https://example.com/application-form",
  });

  assert.equal(result.primary_reason, "NO_VALID_CONTACT");
  assert.deepEqual(result.reasons, ["NO_VALID_CONTACT"]);
  assert.equal(result.eligibility_evidence[0].source, "contact_info");
});


test("Telegram bot as the only contact uses the specific bot rejection", () => {
  const result = prepare({ "Contact Info": "https://t.me/apply_helper_bot" });

  assert.equal(result.primary_reason, "TELEGRAM_BOT_CONTACT");
  assert.deepEqual(result.reasons, ["TELEGRAM_BOT_CONTACT"]);
  assert.equal(result.reasons.includes("NO_VALID_CONTACT"), false);
});


test("bot plus valid email passes and normalized contact discards the bot", () => {
  const result = prepare({
    "Contact Info": "@apply_helper_bot or Jobs@Example.COM",
  });

  assert.equal(result.processing_status, "PROCESSING");
  assert.equal(result.normalized_contact_info, "jobs@example.com");
});


test("email, phone, Telegram username, and direct t.me contact normalize deterministically", () => {
  const result = normalizeContactInfo(
    "Jobs@Example.com; +972 (50) 123-4567; @Hiring_Person; https://t.me/Recruiter_Name",
  );

  assert.deepEqual(result.usable, [
    "jobs@example.com",
    "@recruiter_name",
    "@hiring_person",
    "+972501234567",
  ]);
  assert.equal(result.has_valid_contact, true);
});


test("same normalized Original Link with matching project and vacancy text is an exact duplicate", () => {
  const existing = [
    {
      ...VALID_ROW,
      row_number: 2,
      application_id: "previous-id",
      "Original Link": "https://EXAMPLE.com/jobs/1#details",
    },
  ];

  const result = prepare({}, existing);

  assert.equal(result.primary_reason, "DUPLICATE_APPLICATION");
  assert.equal(result.duplicate.match, "ORIGINAL_LINK");
});


test("same normalized Project Link plus exact normalized description is a duplicate", () => {
  const current = {
    row_number: 3,
    application_id: "current-id",
    short_description: normalizeForExactComparison("Teach   adults.\nRemote."),
    project_link: inspectUrl("https://example.com/project#about").normalized,
    original_link: inspectUrl("https://example.com/jobs/new").normalized,
  };
  const duplicate = findExactDuplicate(current, [
    {
      ...VALID_ROW,
      row_number: 2,
      application_id: "previous-id",
      "Short Description": "Teach adults. Remote.",
      "Project Website Link": "https://EXAMPLE.com/project",
      "Original Link": "https://example.com/jobs/old",
    },
  ]);

  assert.equal(duplicate.is_duplicate, true);
  assert.equal(duplicate.match, "PROJECT_LINK_AND_SHORT_DESCRIPTION");
});


test("same employer with a different description is not a duplicate", () => {
  const existing = [
    {
      ...VALID_ROW,
      row_number: 2,
      application_id: "previous-id",
      "Short Description": "Design learning products.",
      "Original Link": "https://example.com/jobs/other",
    },
  ];

  const result = prepare({}, existing);

  assert.equal(result.duplicate.is_duplicate, false);
  assert.equal(result.processing_status, "PROCESSING");
});


test("manual re-run does not identify the same application as its own duplicate", () => {
  const existing = [{ ...VALID_ROW, application_id: "same-id" }];
  const result = prepare({ application_id: "same-id" }, existing);

  assert.equal(result.duplicate.is_duplicate, false);
});


test("shared recruiting URL classification uses an exact conservative allow-list", () => {
  for (const url of [
    "https://example.com/career",
    "https://example.com/en/careers/",
    "https://example.com/jobs",
    "https://example.com/company/vacancies/",
    "https://example.com/work-with-us",
    "https://example.com/careers/open-positions/",
  ]) {
    assert.equal(isSharedGenericRecruitingUrl(url), true, url);
  }

  for (const url of [
    "https://careers.example.com/",
    "https://example.com/jobs/123",
    "https://example.com/careers/software-engineer",
    "https://example.com/careers?job=123",
    "https://example.com/opportunities",
  ]) {
    assert.equal(isSharedGenericRecruitingUrl(url), false, url);
  }
});


test("same shared careers page with different vacancy descriptions is not a duplicate", () => {
  const result = prepare(
    {
      row_number: 18,
      "Short Description": "Teach mathematics.",
      "Original Link": "https://lgeg.ru/career",
    },
    [{
      ...VALID_ROW,
      row_number: 17,
      application_id: "previous-id",
      "Short Description": "Teach English.",
      "Original Link": "https://LGEG.ru/career#vacancies",
    }],
  );

  assert.equal(result.duplicate.is_duplicate, false);
  assert.equal(result.processing_status, "PROCESSING");
});


test("current application never compares against later rows", () => {
  const result = prepare(
    { row_number: 17 },
    [{ ...VALID_ROW, row_number: 18, application_id: "future-id" }],
  );

  assert.equal(result.duplicate.is_duplicate, false);
  assert.equal(result.processing_status, "PROCESSING");
});


test("same shared careers page falls back to the secondary exact duplicate rule", () => {
  const result = prepare(
    { row_number: 18, "Original Link": "https://lgeg.ru/career" },
    [{
      ...VALID_ROW,
      row_number: 17,
      application_id: "previous-id",
      "Original Link": "https://LGEG.ru/career#vacancies",
    }],
  );

  assert.equal(result.primary_reason, "DUPLICATE_APPLICATION");
  assert.equal(result.duplicate.match, "PROJECT_LINK_AND_SHORT_DESCRIPTION");
});


test("shared careers page needs both secondary-rule fields to match", () => {
  for (const existing of [
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
    const result = prepare(
      { row_number: 18, "Original Link": "https://lgeg.ru/career" },
      [existing],
    );
    assert.equal(result.duplicate.is_duplicate, false, existing.application_id);
    assert.equal(result.processing_status, "PROCESSING", existing.application_id);
  }
});


test("normalization remains exact and does not erase path or query differences", () => {
  assert.equal(
    inspectUrl("https://example.com/job?a=1").normalized ===
      inspectUrl("https://example.com/job?a=2").normalized,
    false,
  );
  assert.equal(normalizeStructuredText("Role A"), "Role A");
  assert.notEqual(
    normalizeForExactComparison("Role A"),
    normalizeForExactComparison("role a"),
  );
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
  test("" + scenario.name, async () => {
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
      const actual = prepareApplication(selected, [earlier]);
      assert.equal(actual.duplicate.is_duplicate, scenario.duplicate, url);
      assert.equal(actual.processing_status, scenario.duplicate ? "REJECTED" : "PROCESSING", url);
      if (scenario.duplicate) {
        assert.equal(actual.duplicate.match, "ORIGINAL_LINK", url);
        assert.equal(actual.duplicate.existing_application_id, "earlier-english", url);
      }
    }
  });
}

test("" + "careers and jobs retain exact secondary evidence and first submission wins", async () => {
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
      const actual = prepareApplication(selected, [earlier]);
      assert.equal(actual.duplicate.is_duplicate, variant === "same-role", `${path}: ${variant}`);
      if (variant === "same-role") {
        assert.equal(actual.duplicate.match, "PROJECT_LINK_AND_SHORT_DESCRIPTION");
      }
    }
  }
});

test("" + "reused URL scans past other roles and keeps the original submission on rerun", async () => {
  const english = { ...VALID_ROW, row_number: 5, application_id: "first-english",
    "Short Description": "English teacher.", "Original Link": "https://example.org/laba#english" };
  const mathematics = { ...english, row_number: 6, application_id: "first-mathematics",
    "Short Description": "Mathematics teacher.", "Original Link": "https://example.org/laba#mathematics" };
  const repeated = { ...english, row_number: 7, application_id: "repeated-english" };
  const rows = [mathematics, repeated, english];
  for (const selected of [english, mathematics, repeated]) {
    const actual = prepareApplication(selected, rows);
    assert.equal(actual.duplicate.is_duplicate, selected === repeated);
    if (selected === repeated) assert.equal(actual.duplicate.existing_application_id, "first-english");
  }
});
