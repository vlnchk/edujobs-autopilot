# Workflow A Implementation Status

**Canonical spec:** `WORKFLOW_A_IMPLEMENTATION_SPEC.md` version 2.3.1, including its dated amendments
**Last updated:** 2026-10-25
**Overall status:** M0–M7 DONE; installed on the server n8n and running in production

This is a summary. The detailed per-change evidence log (commands, execution numbers, row-by-row results) is kept in the private working repository.

## Milestones

| Milestone | Scope | Status |
|---|---|---|
| M0 | Canonical spec, agent instructions, milestone tracking and decision log. | DONE |
| M1 | Stateless worker API contract, configuration, URL safety, SSRF and redirect protection, resource limits. | DONE |
| M2 | Worker extraction paths (HTML, PDF, DOCX, Google Docs/Drive, Notion), cleanup, Browserless fallback, result semantics. | DONE |
| M3 | Deterministic intake, normalization, contact, URL, duplicate and eligibility pre-checks. | DONE |
| M4 | n8n one-row intake, source acquisition and oversized-source context selection. | DONE |
| M5 | Combined eligibility and editorial-mode decision, strict contract validation, deterministic short-circuits and routing. | DONE |
| M6 | KEEP / MINIMAL / ENRICH editing, validation, conservative fallback, Google Sheets persistence and telemetry. | DONE |
| M7 | Docker Compose sandbox, n8n import and runtime verification, integrated checks and runbook. | DONE |

## Work after M7

Each change below came from live test runs on non-production data, was specified in the canonical spec first where it changed a requirement, and was verified with tests before it was accepted.

- **Spec amendments:** publication record (nullable role/employer, emoji-free descriptions), project-name hyperlinks, editorial concision and sufficiency, one post shape within a soft 900-character visible-length budget shared with Workflow B, opening and evaluative-wording refinements, and the semantic responsibility amendment (one owner for each semantic judgment).
- **Eligibility policy:** temporary, project-based and outsourcing work; social-impact and employee-engagement roles; duplicate detection for earlier rows, shared recruiting pages and reused Original Links.
- **Editorial quality:** material-meaning preservation, ENRICH fact accounting against approved evidence, source-conflict handling, completeness across fallback, reviewer drafts for rejected and review rows.
- **Extraction:** Google Drive file viewer route, loading-placeholder classification, noisy-source handling.
- **Operations:** sequential range runner with an unknown-write safeguard, environment-agnostic credential references, offline prompt and model evaluation harness.

## Live verification

- Repeated user-operated runs on non-production rows (2026-09-09 to 2026-10-07) drove the post-M7 fixes above. The final local acceptance run (rows 2–13, 2026-10-07) completed every execution successfully.
- End-to-end run Workflow A → human review → Workflow B on a test Telegram channel passed on 2026-10-08.
- Server installation (spec Section 22.1) completed on 2026-10-24/25: content-worker service, environment block, and three workflows (Vacancy Intake, Intake Trigger, Telegram Publisher) imported identical to their builds. The first server runs of rows 2–6 on 2026-10-25 succeeded; every validator passed on its first attempt.

## Verification

All checks run offline, with no credentials or production data:

```sh
node --test
```

```sh
cd worker && python -m pytest
```

Latest results: 797/797 Node.js tests and 81/81 Python tests PASS. `tests/verify-sandbox.sh` imports the generated workflows into a pinned n8n 2.35.7 container and checks the worker and Browserless boundary.

## Known limitations

- Image-only or scanned PDFs return `EXTRACTION_FAILED`; OCR is an explicit non-goal.
- A plain `t.me/username` cannot be told apart from a channel without a network lookup, so it is treated as a direct contact.
- A link followed by free text in the same form field is not normalized; changing that needs an amendment of both specs.
- The range runner assumes no concurrent edits to the selected rows during a run.

## Next task

None open. New behavior starts with an approved amendment of the canonical spec.
