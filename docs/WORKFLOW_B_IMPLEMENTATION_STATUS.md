# Workflow B Implementation Status

**Canonical spec:** `WORKFLOW_B_IMPLEMENTATION_SPEC.md` version 1.0 Final, including its dated amendments
**Last updated:** 2026-10-25
**Overall status:** M0–M6 DONE; installed on the server n8n and publishing to the production channel

This is a summary. The detailed per-change evidence log (commands, execution numbers, batch-by-batch results) is kept in the private working repository.

## Milestones

| Milestone | Scope | Status |
|---|---|---|
| M0 | Canonical spec, project boundary, builder and test skeleton. | DONE |
| M1 | Deterministic domain model: human decisions, publication order, batch selection, renderer, length preflight, state model, frozen snapshots. | DONE |
| M2 | Google Sheets review and control surface: Review Queue, Archive, batch persistence, active-batch claim. | DONE |
| M3 | Telegram publication path: START marker, sequential vacancy posts, END marker, per-message acknowledgement persistence, transport preflight and HTML escaping. | DONE |
| M4 | Manual whole-batch restart: full frozen-batch preflight, atomic delivery reset, completed-history protection, stop on failure. | DONE |
| M5 | Integrated workflow verification: generated workflow, n8n 2.35.7 import and runtime, credential references, mocked end-to-end batches, no LLM calls, no secret leakage. | DONE |
| M6 | User-operated non-production verification on a test sheet and test channel. | DONE (operator-reported) |

## Work after the milestones

- **Unified manual run:** one execution creates the batch and publishes it, controlled by a single checkbox in the sheet.
- **Presentation contracts:** project-name hyperlinks (O-008), list and contact presentation (O-009), submitted links and Telegram contacts read through Workflow A's shared helpers (O-010). Each new presentation version is frozen per batch, so a retry of an older batch keeps its original rendering.
- **Shared length budget:** the 900-character visible-length check is the same code as in Workflow A; link URLs and Markdown syntax do not count.
- **Server installation:** setup mode creates the review, archive, control and batch tabs in the shared workbook.

## Live verification

- M6 on a test sheet and test channel. The operator reported steps 1–11 as passing and skipped steps 12–13 as unnecessary at this stage; skipped checks are not counted as PASS.
- End-to-end run Workflow A → human review → Workflow B on the test channel passed on 2026-10-08: START marker, four vacancies and END marker, all items SENT.
- Live control batches on 2026-10-08 confirmed preflight failures stop before any write or send.
- On 2026-10-25 a test batch completed in the test channel, and the operator switched the workflow to the production channel.

## Verification

All checks run offline, with no credentials or production data:

```sh
node --test n8n/workflow-b*.test.mjs
```

Latest result: 545/545 PASS. These suites are also part of the full `node --test` run (797/797 PASS). `n8n/verify-workflow-b-runtime.mjs` checks the generated workflow in a pinned n8n 2.35.7 runtime; `n8n/verify-workflow-b-hygiene.mjs` scans the Workflow B files for secrets.

## Known limitations

- Recovery is a manual whole-batch restart by design: after a failed attempt the operator deletes its Telegram messages and reruns the same batch from START. There is no partial resume and no automatic Telegram retry.
- A batch stuck in `PUBLISHING` after a crash needs manual verification in n8n, Telegram cleanup and a manual change to `FAILED` before retry.

## Next task

None open. New behavior starts with an approved amendment of the canonical spec.
