# Workflow B — unified manual operation and migration

Current normal mode is `WORKFLOW_B_MODE=run` (also the default if unset/empty). The existing Sheets checkbox and one Manual Trigger execution create and publish a new frozen batch through START → every vacancy → END. An existing CREATED/FAILED batch takes priority and uses its frozen content regardless of the checkbox. Each execution handles at most one batch. Keep the workflow inactive and run only one execution at a time.

The earlier duplicate M6 waiver covered previous behavior. **Current-stage manual acceptance is closed:** the operator reports passing chat steps 1–11 and explicitly skips steps 12–13 (interruption/cleanup/full retry and the additional live one-batch check). These skips are not live PASS results; canonical recovery requirements remain unchanged. No live resources were accessed by the agent during implementation. This change introduces no new milestone or production authorization.

## Fresh inactive import artifact

Delivered path: `/tmp/workflow-b-run-import.json`. Temporary files may disappear; rebuild from the repository root:

```sh
env -i PATH="$PATH" node n8n/build-workflow-b.mjs /tmp/workflow-b-run-import.json --credential-free
node n8n/verify-workflow-b-hygiene.mjs /tmp/workflow-b-run-import.json
```

The builder emits an inactive 47-node artifact. This portable export has **no credential bindings**. In test n8n 2.35.7, use Import from file and select the existing Google Service Account credential on all 11 Google HTTP Request nodes. Bind the same existing Telegram bot credential on Telegram Get Chat, Telegram Get Administrators and Telegram Send Message. Save inactive. No OpenAI or n8n API credential is used.

Alternatively, build without `--credential-free` after exporting the four existing reference variables: `N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID`, `N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_NAME`, `N8N_TELEGRAM_CREDENTIAL_ID`, `N8N_TELEGRAM_CREDENTIAL_NAME`. These are references, not secrets; the builder does not load `.env`. Use a separate output path. Preserve private `n8n/workflow-b.json`; never hand-edit or commit generated JSON.

## Routine operation

Edit canonical Applications, not projection output. Review the draft, exact project selection/link, Original Link and Contact Info; mark PUBLISH and set unique numeric publication orders. With no unfinished batch, check “Publish approved vacancies” and execute once. Latest values are reread, all selected rows must pass preflight, and a single atomic request saves the claim, complete snapshot, associations and checkbox reset. Durable same-ID read-back must succeed before publication preflight and sending.

| Starting state | Result of one `run` |
| --- | --- |
| No unfinished batch, checkbox off | INACTIVE; zero writes or Telegram operations |
| No unfinished batch, checkbox on, valid candidates | Create/freeze one batch, confirm it, preflight, START → N vacancies → END, COMPLETED |
| No candidates | NO_CANDIDATES; reset checkbox, no batch or Telegram operations |
| Invalid candidates | PREFLIGHT_FAILED or named structural error; no partial batch or sends; correct Applications |
| CREATED | Preflight and publish the same snapshot without requiring the checkbox |
| FAILED | After external operator cleanup, preflight, atomic delivery-only reset, then full restart of the same batch |
| PUBLISHING | BATCH_ALREADY_PUBLISHING; zero Sheets writes, including no checkbox reset, and zero Telegram operations |
| Only completed history, checkbox off | INACTIVE; preserve history and send nothing |

Existing-batch paths leave the creation checkbox unchanged and stop after that batch. Additional approvals never cause another batch in the same execution. A still-checked creation checkbox is honored only by a later execution with no unfinished batch; uncheck it if another batch is not intended. A later explicit checkbox action can publish newly eligible rows.

Publication preflight failure after successful creation leaves a valid CREATED batch for a later run. It does not reread editorial content to rebuild the batch. A different winning creation claim returns ACTIVE_BATCH with `overlapping_winner=true` and `publication_confirmed=false`, then stops without publication. A resolved lost creation response may continue only after same-ID durable read-back; an unresolved creation or publishing-state write must send nothing. Start subsequent attempts from Manual Trigger, never cached write/send nodes.

## Manual cleanup and full retry

After a stopped FAILED attempt, remove every Telegram message from that attempt, including START, vacancies, END if present, and messages whose acknowledgement was lost. Preserve older completed batches. Fix the failure cause, then execute `run` once with the same settings. No checkbox or recovery confirmation control is needed; Workflow B does not verify or perform cleanup.

All frozen payloads, Application acknowledgement targets, destination and bot permission are checked before the single atomic delivery-only reset. Failed preflight preserves delivery evidence. Successful retry sends START and every vacancy again, never a partial resume. Telegram errors including 429 stop immediately without automatic retry or deletion.

For crash-stuck PUBLISHING: verify in the n8n UI that no publisher is running, clean all attempt messages, manually change only that batch's status to FAILED, then execute again. For an uncertain END commit, inspect Sheets first: preserve COMPLETED and its messages.

## Verification

The Workflow B regression suite runs offline, with Sheets and Telegram mocked:

```sh
node --test n8n/workflow-b*.test.mjs
```

`n8n/verify-workflow-b-runtime.mjs` checks the generated workflow in a pinned n8n 2.35.7 runtime. Live rendering, projections, permissions and the full n8n scheduler are not established by these checks. The single-operator constraint is unchanged.
