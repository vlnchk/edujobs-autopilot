# EduJobs Workflow A — local sandbox runbook

This repository implements Workflow A from `WORKFLOW_A_IMPLEMENTATION_SPEC.md` v2.3.1. One inactive n8n workflow processes exactly one explicitly selected Google Sheets row, fetches both submitted links through a stateless content worker, and persists one terminal result. The local sandbox contains only:

- n8n `2.35.7`, using its built-in SQLite database;
- Browserless Chromium for the worker's single JavaScript-rendering fallback;
- the stateless Python content worker.

Only n8n is published to the host, at `127.0.0.1:5678`. Browserless and the worker are reachable only on the Compose network. This is a local manual-test environment, not a production deployment.

Do not use a production spreadsheet, production credentials, or production identifiers. The workflow is inactive after import and must remain inactive for this manual one-row test.

## Prerequisites

- Docker Desktop with Docker Compose v2;
- a non-production Google Sheet with disposable test data;
- a Google Cloud service account limited to that test Sheet;
- an OpenAI API project/key intended for this test;
- optional for host-side tests: Node.js and Python 3.12.

## 1. Values you must replace

Copy the example file first; this command contains no secret or user-specific value:

```sh
cp .env.example .env
chmod 600 .env
```

Edit `.env` locally. Replace only the following values:

| Variable | User-provided value |
|---|---|
| `WORKFLOW_A_TEST_ROW_NUMBER` | One integer Sheet row number, at least `2`. |
| `GOOGLE_SHEETS_DOCUMENT_ID` | The ID of a disposable, non-production spreadsheet. |
| `GOOGLE_SHEETS_SHEET_NAME` | The exact tab name in that spreadsheet. |
| `N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID` | The ID of the Google Service Account API credential already created in this n8n environment. |
| `N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_NAME` | The exact saved name of that Google credential. |
| `N8N_OPENAI_CREDENTIAL_ID` | The ID of the OpenAI API credential already created in this n8n environment. |
| `N8N_OPENAI_CREDENTIAL_NAME` | The exact saved name of that OpenAI credential. |
| `ELIGIBILITY_MODEL` | An available OpenAI model ID; this also handles oversized-source context selection. |
| `EDITOR_MODEL` | An available OpenAI model ID. |
| `VALIDATOR_MODEL` | An available OpenAI model ID. |
| `VALIDATOR_REASONING_EFFORT` | Optional. The validator's reasoning effort for a model that supports it, for example `high`; leave empty for the provider default. |
| `CONFIG_VERSION` | A non-secret label for this coherent prompt/model configuration, for example a test release label. |

Keep these supplied sandbox values unless intentionally testing limits:

- `CONTENT_WORKER_URL=http://content-worker:8000`
- `BROWSERLESS_URL=http://browserless:3000/content`
- `WORKFLOW_VERSION=workflow-a-v2.3.1-m7`
- `FETCH_TIMEOUT_SECONDS=15`
- `MAX_REDIRECTS=3`
- `MAX_DOWNLOAD_BYTES=10000000`
- `MAX_EXTRACTED_CHARS=200000`
- `MAX_LLM_SOURCE_CHARS=50000`
- `MAX_PUBLICATION_DESCRIPTION_CHARS=900`

Every description follows one post shape: opening (who is hiring whom), a short project description, the essence of the work (3–5 main duties or key requirements) and conditions (format, employment, pay), each only when the sources state it. The Short Description takes priority; pages fill only the elements it lacks. Contacts, application instructions, details/form links and page service notices are never included, because Workflow B adds the contact and details lines. `MAX_PUBLICATION_DESCRIPTION_CHARS` is a soft budget of visible characters (spaces and line breaks count; URLs and Markdown syntax do not), shared with Workflow B's pre-publication check. Editors aim at 85% of it (765 for 900) so their usual overshoot stays within the maximum. It only keeps over-budget submissions out of KEEP; length never causes validation failure, fallback or NEEDS_REVIEW. Changing it takes effect after restarting n8n; set a new `CONFIG_VERSION` with it.

The former `PUBLICATION_BODY_TARGET_MIN_CHARS`, `PUBLICATION_BODY_TARGET_MAX_CHARS` and `PUBLICATION_BODY_MAX_CHARS` settings are retired and ignored. Remove them from local environment files if present. Regenerate and import the updated inactive workflow with a new `CONFIG_VERSION`; old imported workflows retain their previous behavior until replaced. Worker extraction and large-source safety limits are unchanged.

`MAX_LLM_SOURCE_CHARS` must remain smaller than `MAX_EXTRACTED_CHARS`. The four n8n credential-reference values are non-secret IDs and names; do not put an OpenAI key, Google private key, n8n credential export, or password in `.env`. Secrets belong in n8n's credential store.

Use these exact four credential variable names in local, staging, and production configuration. Only their values may differ; do not create variants such as `_LOCAL`, `_STAGING`, or `_PROD`.

## 2. Validate, build, and start

These are exact commands, run from the repository root:

```sh
docker compose config --quiet
docker compose pull n8n browserless
docker compose build content-worker
docker compose up -d --wait
docker compose ps
```

Expected service state: `n8n`, `browserless`, and `content-worker` are running and healthy. `docker compose config` must show `docker.n8n.io/n8nio/n8n:2.35.7`, and only `127.0.0.1:5678` may appear as a published host port.

Confirm the pinned runtime:

```sh
docker compose exec -T n8n n8n --version
```

Expected output:

```text
2.35.7
```

## 3. Initialize n8n, create credentials, and generate the workflow

Open [http://127.0.0.1:5678](http://127.0.0.1:5678) and create the local n8n owner account if this SQLite volume is new. The owner credentials are local n8n data; do not reuse a production password.

Create the two credentials in this n8n environment before generating the workflow:

1. In a non-production OpenAI API project, create a standard API key. Official OpenAI guidance treats this key as a server-side secret; never add it to this repository or `.env`: [OpenAI API authentication](https://developers.openai.com/api/reference/overview#authentication).
2. In n8n, create an **OpenAI API** credential and save the test key there. Record the exact credential name and its n8n ID in `N8N_OPENAI_CREDENTIAL_NAME` and `N8N_OPENAI_CREDENTIAL_ID`. The ID is visible in the credential page URL.
3. In a test Google Cloud project, enable the Google Sheets API (and Google Drive API if required), create a dedicated service account, and share only the disposable Sheet with it. Google documents the setup here: [Create a service account](https://docs.cloud.google.com/iam/docs/service-accounts-create).
4. Create one JSON key only if your organization permits user-managed service-account keys. Store it outside this repository: [Create and delete service-account keys](https://docs.cloud.google.com/iam/docs/keys-create-delete).
5. In n8n, create a **Google Service Account API** credential with the service-account email and private key. Record its exact name and n8n ID in `N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_NAME` and `N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID`.

Generate the local workflow from the checked-in builder. This command fails if any of the four credential variables is missing or still has a `REPLACE_WITH_` value:

```sh
node --env-file=.env n8n/build-workflow.mjs
```

`n8n/workflow-a.json` is an environment-specific, gitignored artifact. Regenerate it after every Workflow A builder change or credential-reference change; never edit the JSON manually.

Import the generated inactive workflow with these exact commands:

```sh
docker compose stop n8n
docker compose run --rm --no-deps n8n import:workflow --input=/files/n8n/workflow-a.json
docker compose up -d --wait n8n
```

Refresh n8n and open `EduJobs Workflow A - M7 Sandbox Verified`. Confirm that it is inactive. Missing credentials, missing nodes, broken connections, or invalid-expression warnings are not expected.

For the CLI row/range runner, use the CLI import above: it executes workflow ID `edujobs-workflow-a`, regardless of the displayed name. A UI-imported copy may receive another ID and updating that copy will not update the runner's workflow. When same-name copies exist, open `/workflow/edujobs-workflow-a` in n8n to inspect the definition used by the runner. Do not assume a changed `CONFIG_VERSION` means the workflow code was updated.

For UI-only manual testing, **Workflows → Import from File** may be used with `n8n/workflow-a.json`, but that copy is not automatically the CLI runner's target. Keep the selected workflow inactive.

## 4. Verify generated credential bindings

Open `Read Sheet Rows For Selection And Duplicates`, `Persist Terminal State`, and `Read Sheet Rows After Runner Execution`; all three must already reference the configured Google credential. Every HTTP Request node whose URL is `https://api.openai.com/v1/responses` must already reference the configured OpenAI credential under **Predefined Credential Type**. Do not replace those nodes with AI Agent or chain nodes.

Ensure the four model variables in `.env` are model IDs available to the OpenAI credential. The workflow takes model names only from those variables and uses the Responses API with strict JSON Schema; it performs no web search.

If `.env` changes after a container has been created, recreate n8n so it receives the new values:

```sh
docker compose up -d --force-recreate --wait n8n
```

The third Google node is read-only and runs only from the range runner. Credential generation changes only credential references; do not change node operations, expressions, schemas, routes, or persistence mappings.

## 5. Prepare the non-production Sheet

The existing Google Form headers must have these exact names and must not be overwritten:

```text
Timestamp
Short Description
Project Website Link
Original Link
Contact Info
```

Append all canonical derived headers from Section 17 of the spec. The following is one tab-separated header row that can be pasted into row 1 of a new test tab:

```text
Timestamp	Short Description	Project Website Link	Original Link	Contact Info	application_id	processing_status	processed_at	normalized_contact_info	source_requirement_json	original_link_extraction_status	project_link_extraction_status	original_link_context	project_link_context	eligibility_decision	primary_reason	reasons_json	eligibility_evidence_json	review_reason	initial_editorial_mode	final_editorial_mode	role_title	employer_name	project_link_text	draft_description	final_description	facts_added_json	validation_attempts	validation_history_json	workflow_version	config_version	error_code	error_message
```

Do not create a physical `row_number` column. The n8n Google Sheets node supplies that special value from the actual Sheet row and uses it to update only the selected row.

Share only this non-production spreadsheet with the service account's `client_email` as **Editor**. Do not grant access to a production spreadsheet or share it publicly.

Set `GOOGLE_SHEETS_DOCUMENT_ID` to the part between `/d/` and `/edit` in the test Sheet URL. Set `GOOGLE_SHEETS_SHEET_NAME` to the exact tab name, including spaces and capitalization.

## 6. Select exactly one test row

Put one disposable application in the chosen data row. The five raw cells are inputs; derived cells may be empty on first run. Set `WORKFLOW_A_TEST_ROW_NUMBER` to that row's visible Sheet row number. Row 1 is the header, so the first data row is normally `2`.

The workflow reads the tab for exact duplicate comparison but filters on the explicit `row_number`. It fails before external calls unless the selector resolves to exactly one row. It never scans for or batch-processes `NEW` rows.

After changing the row number in `.env`, apply it with:

```sh
docker compose up -d --force-recreate --wait n8n
```

## 7. Run one application manually

1. Open `EduJobs Workflow A - M7 Sandbox Verified`.
2. Confirm the workflow toggle is inactive.
3. Confirm `Workflow Configuration` previews the intended test row, service URL, four models, limits, and versions.
4. Select **Execute Workflow** once. Do not activate the workflow.
5. In the execution view, inspect the one highlighted path. Review/rejected paths may use the shared ENRICH editor and validator for an optional draft while retaining their outcome and null publication modes. Technical ERROR paths bypass drafting. KEEP must bypass all editor and semantic-validator HTTP calls. MINIMAL and ENRICH may use their defined editor/validator paths and conservative fallback.
6. Inspect `Prepare Terminal Persistence`, then verify the same selected Sheet row. No other row should change, and the five raw input columns must remain byte-for-byte unchanged by Workflow A.

This run is intentionally user-operated because it uses the user's designated test integrations. No credentialed end-to-end run is performed by the repository verification.

## 8. Inspect worker connectivity and output

Check health from n8n's Docker network with this exact command:

```sh
docker compose exec -T n8n node -e "fetch('http://content-worker:8000/health').then(r=>r.text()).then(console.log)"
```

Expected output:

```json
{"status":"ok"}
```

Exercise the worker contract against the reserved public example domain, without publishing the worker port:

```sh
docker compose exec -T n8n node -e "fetch('http://content-worker:8000/extract',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'https://example.com/'})}).then(r=>r.json()).then(value=>console.log(JSON.stringify(value,null,2)))"
```

Inspect container logs and the workflow's extraction nodes:

```sh
docker compose logs --tail=100 content-worker browserless
```

A successful worker response has `status=success`, clean `text`, an `extraction_method`, and warnings. A confirmed 404/410 or a non-existent domain is `broken` and rejects as `LINK_BROKEN`; technical extraction or Browserless limitations only remove that context, and the combined EligibilityDecision decides whether the remaining material still allows a safe decision. They are never silently converted into business rejection rules.

## 9. Verify terminal outcomes

`NEW` and `PROCESSING` are non-terminal. For manual user-prepared non-production cases, verify each terminal class below one row at a time. Change `WORKFLOW_A_TEST_ROW_NUMBER`, recreate n8n, and execute manually for each row. The test-only range runner in Section 10 can launch separate one-row executions for an inclusive range; Workflow A itself never selects or processes a range.

Before importing this revision into a test environment, append `project_link_text` (plus `role_title` and `employer_name` if absent) to the existing Sheet (and `draft_description` if migrating from a revision before that field). Do not rename `final_description`. Regenerate/import the complete workflow through the builder so its eligibility/editor/reviewer schemas and column mappings agree. Use a new `CONFIG_VERSION` release label for the changed prompt/configuration contract. The automated suite uses mocked provider/Sheets responses and disposable n8n state.

`project_link_text` is a nullable operator-editable derived field containing the exact visible first project mention in the body, not necessarily the canonical `employer_name`. For `Музей «Коллекция»` it may be `«Коллекция»`. The descriptions store ordinary escaped inline Markdown, for example `Музей [«Коллекция»](https://museum.example/) ищет медиатора…`. The URL comes only from the submitted Project Link under existing intake rules (including supported full Markdown/bare-domain input). No formula, rich-text API, offsets, duplicate destination column or extra model call is used.

Every READY_FOR_PUBLISH row must have equal linked draft/final descriptions, a resolved selection and a valid first-occurrence wrapper. Length diagnostics include the encoded URL and all Markdown but do not affect publication eligibility. Accepted placement failures use existing contract validation/fallback and ultimately NEEDS_REVIEW; useful reviewer text remains, final stays blank. Reviewer/rejected drafts also link where possible; recovery resets unresolved selection without discarding text. Identity selection is semantic: KEEP uses the existing eligibility call and editors return selection per candidate. Operators changing a body's first mention should update `project_link_text` consistently. A rerun overwrites these derived edits.

Supported insertion handles plain/escaped text, inline emphasis/strong/strikethrough, literal brackets, inline links, whole inline-code mentions, common HTML entities, and surrounding headings/lists. URL destinations, bare URLs and autolinks are excluded from mention matching. Partial code-span selections remain unresolved rather than linking a later occurrence. Reference links/images, HTML, titled links, overlapping link labels and ambiguous/unbalanced formatting are left intact and unresolved. Correct existing links survive; wrong selected destinations are replaced; wrappers never nest. Sanitation precedes insertion, and generated URL characters are percent-encoded so later sanitation cannot damage the wrapper.

A hyperlink is not source verification. Both links are fetched under Stage 3; a confirmed dead Project Link rejects as `LINK_BROKEN`, a technical failure does not prevent the wrapper, and an unread link that prevents a safe decision keeps the combined decision's NEEDS_REVIEW. Link success cannot authorize publication.

The semantic validator receives the editor's body without the code-created hyperlink and never receives `project_link_text` (2026-10-06 amendment, Section 14.1): the selecting call owns the selection, and code verifies that the selected text occurs and places the link. Model-written URLs are still checked before insertion, and the final stored link is checked deterministically.

For ACCEPT + ENRICH, EligibilityDecision also returns `material_gaps`: the sufficiency elements that the submission lacks and a readable link supplies, each named once as `EMPLOYER`, `ROLE` or `WORK`. Any other value, a repeated element, gaps outside ACCEPT + ENRICH, or gaps without approved link content fail the existing contract retry. A recorded gap is transient execution data, not a Sheet column: the accepted ENRICH editor and validator receive it, while MINIMAL and KEEP fallback fail it deterministically with `MEANING_LOST` because they cannot add external facts. MINIMAL editor and validator inputs are unchanged. KEEP's `review_reason` then names the missing elements.

Safe local acceptance: run `node --test n8n/workflow-a.test.mjs workflow-logic/*.test.mjs tests/*.test.mjs`, then `./tests/verify-sandbox.sh` for disposable n8n 2.35.7 generation/import/runtime checks using fake references. In a separately authorized non-production integration run, add the header, change CONFIG_VERSION, regenerate/import with the same four environment-agnostic credential variables, and check KEEP, MINIMAL, ENRICH, earlier aliases, wrong existing destinations, length-boundary fallback, reviewer preservation and rerun reset. Do not infer live model quality from mocked regressions.

`role_title` and `employer_name` are nullable, operator-editable derived fields. They contain concise supported role/employer names, not a creative headline; unavailable or unresolved identity stays null (an empty Sheet cell) without changing status. The existing eligibility call extracts them for KEEP/MINIMAL/ENRICH and semantic review/rejection. Earlier terminal cases reuse the optional shared reviewer editor and factual validator to obtain them; deterministic cases without a usable semantic result may leave them empty. Names cannot be invented or inferred from URLs/contact addresses. MINIMAL receives no extra external context through these fields, and KEEP still has no editor/validator model call.

Both description columns are deterministically emoji-free; raw submissions and source evidence remain unchanged. All AI editors request a natural vacancy-body opening identifying the employer and role when their permitted evidence supports it. `draft_description` is the editable working copy; `final_description` is Workflow A's machine-validated publication output. Workflow B will use the latest operator-edited `draft_description` and identity fields, subject to its separately specified delivery checks; Workflow A imposes no downstream length limit. No later LLM rewriting, shortening or classification is required by this contract, and no Workflow B or Telegram behavior is implemented here. Reprocessing recalculates the identity fields, `project_link_text`, and both descriptions.

A draft never authorizes publication. When content-loss validation fails and approved usable context exists, terminal persistence can recover the draft from the full cleaned context with whitespace cleanup and deterministic emoji sanitation, without a publication length cap. Recovery clears the failed draft's hyperlink selection. It may reuse the existing submission selection only when the whole sanitized submission remains the exact opening segment and link insertion preserves all appended context; otherwise the field stays unresolved. The failed validation, business outcome and blank final description remain authoritative; this recovery calls no LLM. Inspect it alongside the raw form fields, source contexts, `review_reason` and rejection evidence. Empty/unreliable content or a failed optional draft attempt can leave the field blank. Manual reprocessing intentionally replaces both generated description columns under the existing derived-field policy; a contract retry preserves the same in-flight state. Normal accepted MINIMAL/ENRICH processing generates once, then reuses the validated text in both columns; KEEP uses no editorial LLM.

| Terminal status | Required Sheet evidence |
|---|---|
| `READY_FOR_PUBLISH` | `eligibility_decision=ACCEPT`; non-empty, emoji-free `draft_description` equal to validated `final_description`, valid initial/final editorial modes; `validation_attempts` and ordered `validation_history_json`; empty error fields. |
| `REJECTED` | `eligibility_decision=REJECT`; closed-enum `primary_reason`; matching `reasons_json`; concrete `eligibility_evidence_json`; optional non-publishable `draft_description`; empty `final_description`. |
| `NEEDS_REVIEW` | Non-empty `review_reason` explaining semantic/extraction uncertainty; no invented rejection reason; optional non-publishable `draft_description`; empty `final_description`; empty technical error fields. |
| `ERROR` | Non-empty `error_code` and `error_message` for an integration/contract/internal failure; empty `final_description`; no conversion into a semantic rejection. |

Every terminal row must also have `application_id`, ISO `processed_at`, `workflow_version`, and `config_version`. JSON cells must contain compact valid JSON. Only `READY_FOR_PUBLISH` may contain a final description.

Use representative test cases you control. To exercise `ERROR` without production access, a user may deliberately configure an invalid test-only model ID or stop the worker for a case whose source is required, run once, inspect the terminal error, then restore the sandbox configuration. Do not intentionally alter production integrations.

## 10. Run an existing row range sequentially

First generate and import the current `n8n/workflow-a.json` as described above, then confirm all credential bindings. Manually populate every selected Sheet row before launching the runner. The runner never creates, edits, clears, normalizes, or resets test inputs outside Workflow A.

Run rows 2 through 21 with:

```sh
node tests/run-workflow-a-range.mjs --start-row 2 --end-row 21
```

The runner temporarily stops only the n8n service so each CLI process has exclusive access to n8n's local SQLite volume. Browserless and the content worker stay running. For every row, it supplies `WORKFLOW_A_RUNNER_ROW_NUMBER` to one separate `n8n execute` process and waits for that process to finish before starting the next row. It restores n8n afterward if n8n was running when the range began. `WORKFLOW_A_TEST_ROW_NUMBER` remains unchanged and continues to control ordinary manual runs.

After the canonical one-row update, runner mode performs one read-only Sheet verification. It compares the complete pre/post application-row snapshots and requires the changed-row set to be exactly the requested row. A normal failure before persistence is recorded with `modified_rows=[]`, and the next row still runs. An unexpected row change, or loss of verification after an update began, stops the range prominently because continuing could risk more test data. Do not edit the Sheet concurrently with a range run, because a concurrent user edit is correctly observed as an unexpected row modification.

The n8n CLI can exit before its large JSON output has been delivered. When a child's stdout has no parseable run result, the runner reads n8n's saved execution read-only through a throwaway `node` container: it records the newest execution ID before each row and accepts only exactly one newer Workflow A execution whose configuration selected that row in runner mode. The saved in-workflow verification is then classified exactly as stdout would have been, and a PASS says `stdout lost; verified from saved execution N`. No, several or foreign saved executions, or a failed query, keep `modified_rows=UNKNOWN` and stop the range.

Example shape (the live report also includes diagnostic length columns):

```text
row | execution | terminal          | status | modified_rows | result
2   | 123       | READY_FOR_PUBLISH | PASS   | [2]           | READY_FOR_PUBLISH
3   | 124       | REJECTED          | PASS   | [3]           | SALES
4   | 125       | EXECUTION_FAILED  | FAIL   | []            | No Sheet write: selected row was not found

Tested: 3
Passed: 2
Failed: 1
```

The report also shows `input_chars`, `draft_chars` and `final_chars`. Counts use Unicode code points: the selected raw Short Description for input and the terminal stored descriptions, including spaces, Markdown and URLs, for output. Empty output counts as zero; older workflows without diagnostics show `-`. These values never change PASS/FAIL or row-write isolation checks and add no Sheet columns.

The runner exits non-zero if any case fails. A persisted Workflow A `ERROR` is still a valid terminal workflow outcome and passes the harness when exactly the intended row was updated; its error code and message appear in `result`.

## 11. Verify re-run behavior

Record the five raw values and `application_id`, execute the same selected row again, and compare:

- all five raw fields are unchanged;
- the existing `application_id` is preserved;
- derived decisions, output, telemetry, errors, and `processed_at` are recalculated and may be overwritten;
- exactly one row is updated again.

A separate immutable audit log is intentionally not part of this MVP.

The `source_requirement_json` column stays in the Sheet and is written empty: the separate source-requirement call was retired by the 2026-10-06 semantic responsibility amendment.

Installation on the existing server n8n is described in [docs/SERVER_RUNBOOK.md](SERVER_RUNBOOK.md).

## 12. Automated checks without credentials

Set up the optional local Python environment:

```sh
python3.12 -m venv .venv
./.venv/bin/python -m pip install -e './worker[test]'
```

Run all host-side suites:

```sh
node --check n8n/build-workflow.mjs
node --check n8n/workflow-a.test.mjs
node --check n8n/verify-runtime.mjs
node --check tests/sandbox.test.mjs
node --check tests/run-workflow-a-range.mjs
node --check tests/run-workflow-a-range.test.mjs
node --check workflow-logic/deterministic.mjs
node --check workflow-logic/deterministic.test.mjs
node --test n8n/workflow-a.test.mjs workflow-logic/*.test.mjs tests/*.test.mjs
./.venv/bin/python -m compileall -q worker/app worker/tests
(cd worker && ../.venv/bin/python -m pytest -q)
./.venv/bin/python -m pip check
```

The full disposable container/import verification uses `.env.example`, makes no model or Google call, and removes its own containers, network, and SQLite volume:

```sh
./tests/verify-sandbox.sh
```

### Offline prompt and model evaluation

`n8n/eval-replay.mjs` executes a generated workflow JSON outside n8n with the same Code-node sandbox as the tests. Sheet rows and content-worker responses are replayed from a read-only copy of the n8n SQLite database; only OpenAI calls are live, and nothing is written to Sheets, n8n or the worker. Keep the dataset under the ignored `.cache/`: it contains real submissions and contacts. Put only `OPENAI_API_KEY=...` into the ignored `.env.eval`.

```sh
docker cp vers_2-n8n-1:/home/node/.n8n/database.sqlite .cache/eval/n8n.sqlite
node n8n/eval-replay.mjs extract --db .cache/eval/n8n.sqlite --executions 486-533 --out .cache/eval/dataset.json
node n8n/eval-replay.mjs run --workflow n8n/workflow-a.json --dataset .cache/eval/dataset.json --label selfcheck --replay-saved
node --env-file=.env.eval n8n/eval-replay.mjs run --workflow n8n/workflow-a.json --dataset .cache/eval/dataset.json --label candidate --model gpt-6-luna --config validator_reasoning_effort=high --repeats 5
node --env-file=.env.eval n8n/eval-replay.mjs cases --workflow n8n/workflow-a.json --dataset .cache/eval/dataset.json --cases n8n/eval-cases.mjs --contract v2 --label validator --model gpt-6-luna --config validator_reasoning_effort=high
node n8n/eval-replay.mjs report .cache/eval/runs/candidate.json
```

`--replay-saved` makes no API call: it replays the saved model responses and must reproduce every saved terminal row when the workflow equals the one that ran. `cases` replays saved classifier and editor responses for fixed faithful and deliberately corrupted drafts, so only the validator is live; `--dry` checks the case plumbing without API calls. Model results vary between runs: compare configurations over several repeats, not single rows.

## 13. Troubleshooting

- **`docker compose config` reports an unset variable:** copy `.env.example` to `.env` and replace every `REPLACE_WITH_...` value.
- **n8n is not reachable:** run `docker compose ps` and `docker compose logs --tail=100 n8n`; confirm no other process uses local port 5678.
- **A service stays unhealthy:** inspect `docker compose logs --tail=100 content-worker browserless n8n`. The worker depends on Browserless health, and n8n depends on worker health.
- **Workflow generation reports missing credential variables:** define all four `N8N_*_CREDENTIAL_ID`/`N8N_*_CREDENTIAL_NAME` values in `.env`; placeholder values are rejected deliberately.
- **The imported workflow shows a missing credential:** confirm that the credential IDs and exact names belong to this n8n environment, regenerate `n8n/workflow-a.json`, and import that regenerated file.
- **Environment expressions fail:** confirm `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` in `docker compose config`, then recreate n8n rather than merely restarting it.
- **The selected row count is zero:** verify the exact spreadsheet ID, tab name, service-account share, and visible row number. Blank Sheet rows are not returned as application rows.
- **The selected row appears duplicated:** ensure there is no physical `row_number` header and that only one import of the workflow exists.
- **Google returns a column error:** paste every canonical derived header exactly as shown, with no renamed or duplicate headers.
- **OpenAI returns authentication/model errors:** verify the credential in n8n and use model IDs accessible to that API project. The key must not be stored in `.env`.
- **The worker rejects localhost/private IPs:** this is required SSRF protection, not a sandbox defect. Test only public HTTP(S) source URLs.
- **The worker is not reachable from the host:** expected. It has no host port; inspect it from n8n's network with the command in Section 8.
- **Import says the workflow already exists:** do not import twice. Continue with the existing inactive workflow, or reset only the disposable local volume as described below.
- **The range runner says a required service is not running:** run `docker compose up -d --wait`, then retry. The runner manages n8n's temporary stop/start but deliberately does not start missing worker dependencies.
- **The range runner stops after a row-write verification failure:** inspect that execution and the Sheet before continuing. Do not bypass this stop until the unexpected or unverifiable write is understood.

## 14. Shutdown and optional local reset

Clean shutdown preserves the local n8n SQLite state and credentials:

```sh
docker compose down
```

Verify no sandbox container remains:

```sh
docker compose ps
```

Only when you intentionally want to erase the disposable local n8n database, local owner account, credentials, and execution history, use:

```sh
docker compose down --volumes --remove-orphans
```

That reset is destructive only to this Compose project's local named volume. It does not touch a Google Sheet or any other external resource.
