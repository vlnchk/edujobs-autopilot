# EduJobs Workflow Agent Instructions

## Authority

- `WORKFLOW_A_IMPLEMENTATION_SPEC.md` version 2.3.1 is the sole source of truth for Workflow A requirements.
- `WORKFLOW_B_IMPLEMENTATION_SPEC.md` version 1.0 Final, including its dated amendments, is the sole source of truth for Workflow B requirements.
- Each canonical spec supersedes every earlier specification of its workflow. Historical copies, if retained, must be clearly marked `HISTORICAL` and kept outside the root so they cannot be mistaken for active requirements.
- Status, decision, test, and planning files may explain implementation state but may not override the canonical specs.

## Scope

- Workflow A: one application per execution, orchestrated by n8n, with a stateless content worker, Google Sheets state, tests, a minimal local sandbox, and the required runbook. Follow `docs/IMPLEMENTATION_STATUS.md`; record genuinely unspecified choices in `docs/DECISIONS.md`.
- Workflow B: human-reviewed batch publication from Google Sheets to Telegram. Follow `docs/WORKFLOW_B_IMPLEMENTATION_STATUS.md`; record genuinely unspecified choices in `docs/WORKFLOW_B_DECISIONS.md`.
- Update only the status and decision files of the workflow a task changes. A change to a contract shared by both workflows (for example `MAX_PUBLICATION_DESCRIPTION_CHARS` or the visible-length rule) updates both specs and both status files in the same change.
- Workflow B depends only on Workflow A's persisted output contract and shared deterministic helpers. Workflow A must not depend on Workflow B.
- Do not start a later milestone unless the task explicitly requests it.
- Each spec's explicit non-goals remain non-goals, including production deployment or resource changes beyond the approved server installation (Workflow A spec Section 22.1), autonomous agents, queues, extra databases, web search, OCR, and generalized framework abstractions. Workflow A does not format or publish to Telegram; Workflow B does not call OpenAI or another LLM.

## Engineering principles

- Prefer the simplest deterministic solution that satisfies an explicit requirement.
- Use an LLM only for semantic judgment, editing, or semantic validation defined by the spec.
- Do not invent business rules, rejection reasons, source behavior, or acceptance criteria.
- Do not add speculative infrastructure, extension points, layers, or abstractions.
- Preserve raw inputs, keep secrets out of the repository, and never use production credentials or mutate production resources outside the approved server installation steps.

## Questions to the user

- Asking the user is always allowed, at any stage of a task, even when the task does not invite questions. Ask whenever the answer would materially change the result and cannot be determined from the canonical specs, the code, or the status and decision files.
- Always ask before inventing a business rule, rejection reason, source behavior, or acceptance criterion; when a spec contradicts the code, another spec, or the request; when a task would need live, paid, or production resources; and before any hard-to-reverse action.
- Do not ask what you can verify yourself. Collect questions into one message, say why each matters, and recommend an answer. For minor, reversible choices with an obvious default, proceed and state the choice in the completion report.
- An answer that changes a requirement takes effect only after the user approves its wording in the canonical spec. Do not record routine answers.

## Working method

1. Read the relevant canonical spec and implementation status before changing code.
2. Implement only the requested milestone or narrowly scoped task.
3. Run safe, relevant verification without production credentials.
4. Update the relevant status file with evidence, blockers, and the exact next task. Record only genuinely unspecified implementation choices in the relevant decisions file.
5. Mark work complete only when its acceptance checks pass.

Keep commits focused on one coherent change. Do not mix refactors or unrelated cleanup into feature work. Every completion report must list changed files, verification commands and results, blockers or ambiguities, and the recommended exact next task.

## Generated workflow credentials

- Regenerate generated workflow JSON with `n8n/build-workflow.mjs` (Workflow A) or `n8n/build-workflow-b.mjs` (Workflow B); never edit it manually or commit it.
- Keep credential configuration environment-agnostic and out of committed generated files.
- Every future environment must reuse `N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID`, `N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_NAME`, `N8N_OPENAI_CREDENTIAL_ID`, `N8N_OPENAI_CREDENTIAL_NAME`, `N8N_TELEGRAM_CREDENTIAL_ID`, and `N8N_TELEGRAM_CREDENTIAL_NAME` where applicable; do not introduce environment-suffixed variants such as `_LOCAL` or `_PROD`.

## Workflow B operational rules

- Keep Workflow B deterministic, builder-generated, inactive by default, and free of production credentials or resource changes other than its approved server installation, as required by its canonical spec.
- Workflow B publication recovery is manual whole-batch restart: preflight every frozen payload and destination before writes/sends; after a failed attempt the operator cleans all its Telegram messages, then retries the same batch from START. Reset delivery metadata atomically only after preflight passes. A startup PUBLISHING batch returns BATCH_ALREADY_PUBLISHING. Do not implement publisher ownership/takeover, n8n self-API lookup, partial resume, automatic Telegram retry/deletion, or new recovery controls. Preserve the M2 batch-creation claim. A crash-stuck PUBLISHING batch requires manual n8n UI verification, Telegram cleanup, and a manual change to FAILED before retry.
- Do not repeat waived Workflow B live checks unless a task explicitly requests them.
