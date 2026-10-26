# EduJobs — Workflow B Implementation Spec

**Version:** 1.0 Final  
**Status:** Canonical implementation specification  
**Date:** 2026-09-09  
**Amendment:** 2026-09-19 — M4 publication recovery is manual whole-batch restart. This supersedes earlier publication recovery/concurrency requirements. M0–M3 selection, snapshot creation and O-005/O-006 transport remain unchanged.
**Amendment:** 2026-09-20 — deterministic project-name hyperlinks for new snapshots (O-008). This explicitly amends the literal-description Markdown rule and post-link-update length policy, while preserving manual whole-batch restart.
**Amendment:** 2026-09-21 — O-009 deterministic unordered-list and contact presentation for new snapshots only. Reuse O-008 hyperlinks; preserve legacy and project-links-v1 output, original inputs, size policies and manual whole-batch restart.
**Amendment:** 2026-09-23 — unified manual `run` creates and publishes at most one batch per execution; `setup` remains bootstrap-only. Explicit legacy modes require one-time migration. This narrowly supersedes separate prepare/publish routing; all snapshot, transport and recovery contracts remain unchanged.
**Amendment:** 2026-10-06 — the publication maximum `MAX_PUBLICATION_DESCRIPTION_CHARS` defaults to 900 and is the same variable Workflow A reads as its soft editorial budget; the body is measured as visible length under Workflow A Section 13.0.1, so link URLs and Markdown syntax do not count. This supersedes the O-008 code-point counting rule; the complete-message 4096 transport check is unchanged (Section 12).
**Amendment:** 2026-10-08 — O-010 submitted-link representation and Telegram contact presentation for new presentation-v4 snapshots. Project Link and Original Link use Workflow A's shared submitted-link representation; `t.me/<username>` contacts are presented as `@<username>`; an unspaced slash separates fully recognized contact components. Existing frozen formats, size policies and manual whole-batch restart are unchanged.
**Amendment:** 2026-10-08 — O-010 addition for new presentation-v5 snapshots: horizontal whitespace separates contact pieces around recognized usernames, email addresses and URLs (phone spacing is kept), and redundant Telegram and email labels are omitted. Frozen presentation-v4 and earlier snapshots are unchanged.
**Amendment:** 2026-10-24 — server installation. (1) The Applications raw column `Project Link` is named `Project Website Link`; in this spec "Project Link" names that column, and frozen snapshots keep their `project_link` field. (2) Workflow B is installed on the existing server n8n as `EduJobs v2 · Telegram Publisher` under Workflow A Section 22.1: imported inactive, executed manually, reading the same Applications tab as Workflow A. The first destination is a test channel; the user switches to the production channel by changing `WORKFLOW_B_TELEGRAM_CHAT_ID` and restarting n8n, with the same bot as administrator of both channels. The `setup` bootstrap of the new workbook runs once after the user fills the Sheet identifiers. Manual whole-batch restart, frozen formats and size policies are unchanged.
**Upstream dependency:** Workflow A  
**Primary system boundary:** Google Sheets human review → Telegram batch publication

---

## 1. Purpose

Workflow B turns human-reviewed applications into published Telegram vacancy collections.

Workflow A prepares and evaluates each application. Workflow B does not repeat that work. Its responsibility begins at the human-review boundary and ends when the approved batch has been reliably published to Telegram and the publication result has been persisted.

High-level flow:

```text
Workflow A
   ↓
Google Sheets — human review
   ↓
Workflow B
   ↓
Telegram publication
   ↓
Publication metadata + archive state in Google Sheets
```

Workflow B must preserve human editorial control. The machine decision produced by Workflow A is advisory; the human operator makes the final publish/reject decision for MVP.

---

## 2. Product goal

The MVP should allow the operator to:

1. Open one Google Sheets review surface.
2. See all unresolved applications, including machine status and reasons.
3. Edit any publication-relevant field if needed.
4. Mark each application as:
   - `PUBLISH`
   - `REJECT`
   - or leave it unresolved.
5. Assign manual publication order to rows marked `PUBLISH`.
6. Manually activate one publish control.
7. Have Workflow B:
   - create one batch from all currently approved unpublished rows;
   - publish a start marker;
   - publish each vacancy as a separate Telegram post in the specified order;
   - publish an end marker;
   - persist Telegram message metadata after each successful send;
   - archive/close resolved rows without deleting historical source data.
8. After a failed attempt, manually clean its Telegram messages and republish the entire same frozen batch from START.

---

## 3. Core product principles

### 3.1 Human decision is authoritative

Workflow A persists a machine status and related reason/evidence. The current canonical Workflow A review status is `READY_FOR_REVIEW`, but Workflow B must not couple publication logic to a fixed upstream status enum.

For Workflow B, the machine status is informational only.

Workflow B introduces a separate human decision:

- blank = not reviewed
- `PUBLISH`
- `REJECT`

Publication eligibility in Workflow B is determined by:

```text
human_decision = PUBLISH
AND deterministic publication preflight passes
```

A human may therefore publish a row regardless of its Workflow A machine outcome, provided the current Sheet publication data passes deterministic preflight.

Workflow B must:

- never overwrite the Workflow A machine status with the human decision;
- never require a specific Workflow A status in order to publish;
- continue to surface the upstream machine status/reason for review, archive, and later analysis.

### 3.2 No automatic publishing in MVP

Every application must be reviewed by the human operator before publication.

The MVP must not publish any row unless the operator explicitly sets:

```text
human_decision = PUBLISH
```

### 3.3 Google Sheets is the MVP operator interface

No Telegram bot, custom admin panel, or separate review application is required for MVP.

Google Sheets is the canonical human-review UI because it supports:

- list-based review;
- inline editing;
- visible machine status/reasons;
- manual publication ordering;
- simple control fields;
- low operational overhead.

### 3.4 Workflow B performs no semantic editing

After human approval, Workflow B must not:

- rewrite the vacancy;
- shorten it with an LLM;
- generate a new headline;
- infer a new employer or role;
- re-run eligibility;
- repeat Workflow A source acquisition;
- repeat Workflow A editorial validation;
- browse or fetch vacancy sources;
- call OpenAI or another LLM.

Workflow B is a deterministic assembly, publication, and persistence workflow.

### 3.5 Latest human edits are used at batch creation

Before a new batch is created, Workflow B must re-read the latest Sheet values.

This ensures that any edits made after setting `PUBLISH` but before activating the publish control are included.

Once a batch has been created and the publication snapshot frozen, subsequent Sheet edits must not retroactively change already-created batch content.

### 3.6 Historical application data must remain intact

Applications must not be physically deleted or moved out of the canonical application dataset merely because they were published or rejected.

Workflow A depends on historical applications for duplicate detection and first-submission-wins behavior.

Review Queue and Archive are non-destructive projections/views over canonical rows. Their exact Google Sheets implementation should be the least fragile option compatible with the existing workbook and Workflow A.

---

## 4. Scope

Workflow B MVP includes:

- Google Sheets human review state;
- manual publication order;
- manual publish trigger;
- deterministic publication preflight;
- batch creation;
- frozen publication snapshot;
- Telegram start marker;
- one Telegram message per vacancy;
- Telegram end marker;
- sequential publication;
- per-message persistence;
- manual cleanup and full-batch retry after failure;
- per-attempt acknowledgement validation and completed-history protection;
- completed-batch persistence;
- Review Queue projection;
- Archive projection;
- Telegram post URLs/message IDs where possible;
- configurable publication limits;
- installation on the existing server n8n (Workflow A Section 22.1);
- local/mocked verification;
- user-operated non-production live verification.

---

## 5. Explicit non-goals

The following are out of MVP scope:

- fully automatic publishing without human review;
- LLM editing inside Workflow B;
- LLM title/headline generation inside Workflow B;
- paid/free vacancy prioritization;
- publication SLA;
- scheduled publication windows;
- thematic batch splitting;
- multiple simultaneous manual batches;
- multi-user reviewer audit history;
- mandatory human rejection reasons;
- historical Telegram post editing;
- automatic employer follow-up;
- custom admin UI;
- Telegram review bot;
- Workflow C;
- historical `remote` label;
- moving or deleting historical canonical application rows;
- automatic shortening of over-limit human-approved text;
- automatic aging/expiration of unresolved applications;
- exactly-once-like ambiguous-delivery recovery, operator delivery-confirmation commands, or Telegram reconciliation/search/edit/delete.

---

## 6. Upstream contract from Workflow A

Workflow B expects Workflow A to persist, at minimum, the following categories of information.

### 6.1 Machine decision

- machine status;
- rejection/review reason;
- relevant explanatory fields/evidence.

The exact existing Workflow A column names should be reused rather than duplicated.

Workflow B treats these fields as informational context only. It must not encode publication eligibility against a fixed list of Workflow A statuses.

### 6.2 Publication text

- `draft_description`
- `final_description`

For Workflow B:

```text
draft_description
```

is the editable human-review publication source of truth.

`final_description` remains a Workflow A machine artifact and must never be a fallback publication body.

`project_link_text` is a nullable, operator-editable exact visible substring selecting the first project mention. It is allowed to be missing upstream but required for every row in a new publication batch. `employer_name` remains canonical identity metadata and need not equal the displayed mention. Only the latest `Project Link` supplies the project-name destination. Workflow B must not create/populate missing upstream fields or persist mutable character offsets. Missing columns/values require a concrete correction message; see O-008.

### 6.3 Structured role/employer metadata

Expected after the final Workflow A amendment:

- nullable `role_title`
- nullable `employer_name`

These fields are useful for review, search, analytics, and future features.

They are not required for Workflow B publication correctness and must not cause Workflow B to regenerate missing metadata.

### 6.4 Existing application/source fields

Workflow B may reuse existing canonical fields such as:

- Project Website Link;
- Original Link;
- contact;
- raw application fields;
- normalized source fields;
- `application_id`;
- `row_number`.

Do not invent duplicate columns for data already present in Workflow A.

---

## 7. Human-review model

### 7.1 Human decision

Add:

```text
human_decision
```

Allowed MVP values:

```text
blank
PUBLISH
REJECT
```

Semantics:

#### blank

The row is unresolved.

It remains visible in Review Queue indefinitely.

No automatic action is taken.

#### PUBLISH

The row is approved by the human for the next publish batch, subject only to deterministic publication preflight.

The Workflow A machine status does not block publication.

#### REJECT

The row is considered resolved/closed by the human.

It must not be published.

It should disappear from Review Queue and appear in Archive.

No human rejection reason is required in MVP.

### 7.2 Manual publication order

Add:

```text
publication_order
```

The operator sets this manually for rows intended for publication.

Workflow B sorts the selected rows by this value.

The actual Telegram numbering is independent from the raw sort key.

Example:

```text
publication_order = 10, 20, 30
```

may render:

```text
·1·
·2·
·3·
```

Requirements:

- every row selected for a new batch must have `publication_order`;
- values must be unique inside the selected batch;
- gaps are allowed;
- duplicate or missing values fail preflight;
- Workflow B must not guess a missing or conflicting order.


### 7.3 Human editing boundary

Before a new batch is created, the operator may edit any publication-relevant Sheet field used by Workflow B, including where applicable:

- `draft_description`;
- `project_link_text` and `Project Link`;
- details/source link fields;
- contact fields;
- `publication_order`;
- other existing canonical fields used by the deterministic renderer.

Workflow B must re-read the latest Sheet values immediately before new-batch preflight and snapshot creation.

The operator may therefore rewrite the entire publication body manually before publication.

After the batch snapshot is frozen, that batch is immutable for publication purposes. Later Sheet edits must not change the active batch or alter content used during retry.

MVP does not support silently editing an already-started batch. A future explicit cancel/rebuild mechanism may be added if needed.

---

## 8. Google Sheets operator UX

The operator experience should expose three conceptual surfaces.

### 8.1 Applications

Canonical source of truth.

Historical application rows remain here.

Published or rejected rows are not physically removed.

### 8.2 Review Queue

Shows unresolved rows that still require human action or have been approved but not yet fully published.

The exact projection mechanism is implementation-specific and should be chosen after inspecting the existing workbook.

Use the least fragile implementation that:

- does not duplicate canonical ownership of application data;
- keeps resolved rows out of the review surface;
- preserves Workflow A historical duplicate detection.

Do not introduce a separate read-model architecture beyond what Google Sheets requires for these two operator views.

### 8.3 Archive

Shows human-resolved applications:

- `REJECT`;
- successfully published rows.

Archive should expose enough information to understand what happened.

At minimum:

- `human_decision`;
- Workflow A machine status;
- Workflow A reason/review reason;
- `batch_id`;
- `batch_position`;
- `published_at`;
- Telegram message URL.

Archive is a view/projection, not a destructive move of canonical rows.

---

## 9. Manual publish control

Provide a simple Google Sheets control, conceptually:

```text
Publish approved vacancies  ☐
```

A dedicated `Control` tab is recommended.

Expected operator flow:

1. review rows;
2. edit publication fields;
3. set `PUBLISH` or `REJECT`;
4. set `publication_order` for publishable rows;
5. enable the publish control;
6. execute Workflow B once from Manual Trigger in the default `run` mode to create the frozen batch and publish START → every vacancy → END.

The creation control must be reset atomically with the safe new-batch claim so that the same user action does not create repeated independent batches. Preserve the existing no-candidates reset behavior; existing-batch paths are described below.

The exact mechanism may use a checkbox or equivalent simple Sheet field.

The checkbox governs new-batch creation only. In `run`, inspect unfinished persistence first. An existing CREATED or FAILED batch is published/retried from its frozen snapshot independently of the checkbox; leave the checkbox unchanged on this path. A startup PUBLISHING batch returns BATCH_ALREADY_PUBLISHING with zero Sheets writes (including no checkbox reset) and zero Telegram operations. With no unfinished batch, an unchecked control returns INACTIVE with no writes/sends. A checked control rereads latest Applications, preflights all candidates, and preserves the M2 atomic creation claim, snapshot, associations and checkbox reset. No candidates retains NO_CANDIDATES and consumes the checkbox without creating a batch. No recovery control is part of the current contract. Existing unused legacy control content is ignored and left untouched; fresh setup creates only the supported creation control.

After a creation attempt, continue into publication only when durable read-back confirms the same planned batch ID and a complete valid CREATED snapshot with its atomic checkbox reset. Preserve the existing creation-claim read-back: if another batch won, expose that winner and stop without entering publication. A lost write response may be resolved only by that durable confirmation; an unresolved write/read outcome stops without sending. Do not add ownership or locking.

Process at most one batch per execution. Completion of an existing batch ends the execution even if the checkbox remains checked or more approved rows are available. Completed history is never selected for retry or modified; a later checked-control execution may create a new batch from eligible rows. A failed execution stops without automatically making another attempt. If creation succeeds but publication preflight fails, retain the valid frozen CREATED batch for a later manual execution.

Avoid Apps Script unless required for reliability.

---

## 10. Batch model

A publication batch is a first-class entity.

### 10.1 Batch selection

When the operator activates the publish control for a new batch, Workflow B selects all rows satisfying:

```text
human_decision = PUBLISH
AND not successfully published
AND not assigned to another active unfinished batch
```

There is no MVP requirement to manually split simultaneously approved rows into separate batches.

All currently approved unpublished rows form one new batch.

### 10.2 Stable batch identity

Create:

```text
batch_id
```

It must remain stable across full retries.

### 10.3 Canonical batch persistence

Workflow B MVP must use a dedicated Sheet/tab:

```text
Publication Batches
```

as the canonical batch-level persistence surface.

At minimum persist:

- `batch_id`
- batch status
- created/start timestamp
- completed/published timestamp
- vacancy count
- start Telegram message ID
- end Telegram message ID
- last publication error
- optional failure diagnostic note (the existing column name may remain unchanged)

### 10.4 Frozen batch snapshot

Before the first Telegram send:

1. re-read latest application rows;
2. select current PUBLISH/unpublished rows;
3. run deterministic preflight;
4. sort by `publication_order`;
5. assign displayed positions `1..N`;
6. create the batch;
7. persist/freeze the publication snapshot.

After this point, the batch must use its frozen snapshot for all sends and retries.

The implementation may choose the minimal storage layout for frozen batch items, but the snapshot must be durably recoverable from canonical Workflow B persistence.

A partially published batch must not reconstruct already-created content from later Sheet edits.

---

## 11. Telegram publication contract

### 11.1 One batch is multiple Telegram messages

A batch is not one message.

For N vacancies, the sequence is:

```text
START
vacancy 1
vacancy 2
...
vacancy N
END
```

Total messages:

```text
N + 2
```

### 11.2 Start marker

Use exactly:

```text
...start >>
```

### 11.3 End marker

Use exactly:

```text
...end >>
```

### 11.4 Vacancy numbering

Each vacancy is a separate Telegram message.

Render numbering exactly as:

```text
·1·

<vacancy body>
```

That is:

- canonical middle-dot style;
- integer inside the markers;
- one blank line after the numbering before vacancy content.

Numbering resets for every new batch.

Examples:

```text
·1·
·2·
·9·
·10·
·11·
```

The historical `remote` suffix is not part of MVP.

### 11.5 Vacancy body

Workflow B must not generate a new semantic headline.

The publication body is based on the latest approved `draft_description`.

The expected upstream Workflow A behavior is that `draft_description` already contains a natural publication-ready opening when supported by the source material, for example:

```text
Университет X ищет маркетолога образовательных продуктов...
```

Workflow B assembles deterministic presentation, the project-name hyperlink defined in O-008, and the narrow list/contact transformations in O-009 without semantic rewriting.

### 11.6 Details and contact

Conceptual renderer:

```text
·N·

<draft_description>

Детали: <details link>

Контакт: <contact>
```

Use existing canonical Workflow A fields for links/contact.

Do not duplicate source columns.

Telegram messages use HTML parse mode. For O-008 and O-009 snapshots, parse the supported inline links in the description, then HTML-escape every literal span, label and attribute value before adding renderer-generated anchors. O-009 alone also normalizes clearly recognized list markers and contact components. All remaining formatting/contact text stays literal. Only the deterministic Workflow B renderer may introduce supported HTML formatting, including hyperlinks; user text must never be interpreted as arbitrary HTML. The marker and vacancy examples describe visible text, which must also be escaped correctly for transport.

Publish to exactly one fixed numeric channel chat_id using the existing bot with only publishing permissions. Prefer the native n8n Telegram node unless testing demonstrates that it hides information needed for correct acknowledgement/error handling. Use normal notifications, disable link previews, and never automatically edit or delete published messages. See O-006 for the complete transport contract.

The separate “Детали” link uses only Original Link, retaining its full destination and derived domain/path label under O-005. It never substitutes for the project-name hyperlink.

---

## 12. Publication-size policy

Workflow A should normally produce concise publication-ready descriptions.

Workflow B must enforce a deterministic preflight publication maximum.

Canonical MVP default:

```text
MAX_PUBLICATION_DESCRIPTION_CHARS = 900
```

`900` is a product default, not a hard-coded technical constant. Workflow A reads the same variable as its soft editorial budget (Workflow A Section 13.0.1).

The value must be configurable through Workflow B configuration/environment and may be changed without modifying workflow business logic.

Workflow B must not:

- silently truncate;
- call an LLM to shorten;
- rewrite the content.

If a PUBLISH row exceeds the configured limit:

1. fail preflight before creating/sending the batch;
2. send no START marker;
3. identify the offending row clearly;
4. require human editing;
5. allow the operator to trigger publication again after correction.

For new snapshots, measure the canonical Markdown publication body **after** project-link insertion or destination refresh, before removing boundary blank lines for assembly, as visible length under Workflow A Section 13.0.1: every visible character including spaces, line breaks and list markers counts; link URLs, link syntax and other Markdown syntax characters do not. Use the same shared counting rule as Workflow A. Separately validate the complete Telegram message (numbering, body, details, contact) against the existing conservative 4096 UTF-16-unit visible-text bound. Both deterministic checks precede new-batch persistence.

O-009 checks both that existing post-link body bound and the final body after list formatting. Whitespace normalization must not make an otherwise over-limit approved draft pass. The complete transport check uses the derived contact and final body, before any new-batch persistence.

Reviewer/recovery drafts produced by Workflow A may legitimately exceed this value before human editing.

---

## 13. Deterministic preflight

A new batch must not start if any selected row fails deterministic publication preflight.

At minimum validate:

- selected row has `human_decision = PUBLISH`;
- row is not already successfully published;
- row is not claimed by another active unfinished batch;
- `publication_order` exists;
- `publication_order` is unique within the batch;
- `draft_description` is non-empty and usable;
- `project_link_text` is present and selects the earliest valid exact visible occurrence under O-008;
- `Project Link` and all supported inline links pass the existing transport structural URL policy;
- the rendered selected occurrence links to the current Project Link without nested/duplicate wrappers;
- the canonical Markdown body after the link update does not exceed the configured publication maximum;
- the complete message satisfies deterministic Telegram transport length/encoding checks before persistence;
- required Telegram-rendering fields are structurally usable;
- selected rows can be rendered deterministically.

No Workflow A machine status may by itself fail Workflow B preflight.

Render and validate every selected row before persisting any new batch or sending START. A failing row blocks the entire batch with application_id/physical row and a concrete correction; do not drop rows, persist a partial batch, append a generic Project link, invent an anchor, or silently repair text.

Before START, complete transport preflight for the whole frozen batch: validate internal consistency; deterministically render all START + N vacancies + END payloads; validate Telegram size constraints, renderer-contract HTML, publication links, working credentials, expected bot identity, configured numeric channel ID, current bot publishing permission, disabled link previews, and all required transport configuration. Any failed check means nothing is sent. This verifies what Workflow B controls; it cannot guarantee future Telegram availability or network success. See O-006.

---

## 14. Per-application publication metadata

For every successfully sent vacancy persist at minimum:

- `batch_id`
- `batch_position`
- Telegram `message_id`
- Telegram message URL when constructible
- `published_at`

The `batch_position` is the displayed sequence `1..N`, not the raw `publication_order`.

Recommended additional fields for publication diagnostics:

- publication state;
- frozen rendered text or snapshot reference;
- last publish error;
- batch-level failure diagnostics, without any additional delivery state or presend fence.

Do not add fields without clear operational value.

---

## 15. Publication state model

Use only CREATED, PUBLISHING, COMPLETED and FAILED:

```text
CREATED -> PUBLISHING -> COMPLETED
CREATED/PUBLISHING -> FAILED
FAILED -> PUBLISHING -> COMPLETED | FAILED
```

CREATED means the snapshot is frozen. PUBLISHING means an attempt has been committed and is in progress. COMPLETED means START, every vacancy and END have durable acknowledgements and the required metadata is saved. FAILED means an attempt stopped and requires manual Telegram cleanup before full retry.

A preflight failure leaves the existing CREATED/FAILED state unchanged and sends no publication messages. Every valid non-COMPLETED batch remains unfinished and blocks new preparation.

Vacancy item states remain NOT_SENT and SENT. Delivery IDs, URLs, timestamps and item states describe the current/last attempt; they never determine a retry position. NOT_SENT is not proof of Telegram non-delivery. No additional marker states, operator acknowledgement states or recovery controls are introduced.

---

## 16. Sequential publication

After full preflight and the PUBLISHING commit succeed, start an in-memory cursor at zero and send exactly:

```text
START -> vacancy 1 -> vacancy 2 -> ... -> vacancy N -> END
```

Validate each acknowledgement before advancing. Persist successful vacancy delivery fields in both the frozen item and canonical Applications row using one atomic Sheets request. START saves its message ID and timestamp. END saves its message ID, completion timestamp and COMPLETED status atomically. Completed batches and their history are immutable and a normal `run` rerun with the creation checkbox unchecked returns INACTIVE with no sends or unnecessary writes.

Any Telegram failure, including 429, timeout, missing/malformed acknowledgement or uncertain network response, stops all later sends. There is no automatic retry, backoff, Wait node or Telegram reconciliation. Record FAILED, a concise last_publication_error, and a diagnostic explicitly requiring manual Telegram cleanup of all messages from this attempt and full-batch restart from START. Keep successful delivery evidence until the next explicit retry.

An acknowledgement persistence failure also stops the attempt. A single Sheets batch-record read may protect an END commit whose response was lost: leave a persisted COMPLETED batch untouched; otherwise record FAILED without clearing delivery evidence. This read never permits another send. If Sheets cannot be read or failure diagnostics cannot be persisted, stop and use the manual stuck-batch procedure below.

---

## 17. Manual whole-batch retry

**Publication recovery is manual whole-batch restart. Preflight prevents avoidable failures; runtime Telegram failures are handled by operator cleanup and full retry. No publisher ownership/takeover or partial resume is implemented.**

Before executing `run` again for a FAILED batch, the operator manually deletes every Telegram message from that failed attempt, including messages whose acknowledgements may have been lost. Workflow B neither performs nor asks for a separate recorded confirmation of this cleanup.

Every retry must:

1. Reconstruct and validate the complete existing frozen batch, including item count, identity, source references and ordering.
2. Render all final START/vacancy/END payloads and validate O-005/O-006 links, transport constraints and message lengths. Validate canonical Applications IDs, source sheet/rows, batch IDs and positions. Reuse frozen content regardless of later editorial changes.
3. Verify Telegram configuration, channel resolution, credential-bound expected bot identity and current posting permission through Get Chat and Get Administrators.
4. If any preflight fails, send nothing and make no reset mutation; keep FAILED and its existing delivery evidence.
5. Only after every check succeeds, commit the following delivery-only reset in one atomic spreadsheets.batchUpdate request before sending START.

| Surface | Fresh-attempt values for a FAILED batch |
| --- | --- |
| Batch | batch_status=PUBLISHING; clear started_at, completed_at, start_telegram_message_id, end_telegram_message_id, last_publication_error, diagnostic_or_unknown_state_note |
| Every frozen item | item_state=NOT_SENT; clear telegram_message_id, telegram_message_url, published_at |
| Corresponding Applications rows | clear telegram_message_id, telegram_message_url, published_at |

Preserve batch_id, batch_position, publication_order, frozen draft_description/publication_description/project_link_text/project_link/snapshot_version/details_link/contact/publication_contact/rendered_text, application identity/source references, created_at, vacancy_count and workflow/config versions. Never split the reset into separate commits or rewrite frozen fields. Start the runtime cursor at 0; old acknowledgements never skip START or any vacancy.

A fresh CREATED batch passes the same preflight and commits PUBLISHING without rewriting immutable content or unnecessary delivery fields. If the commit response is unconfirmed, send nothing. A committed reset may leave PUBLISHING; manual recovery applies.

---

## 18. Batch creation and publication overlap

Preserve the M2 atomic batch-creation mechanism, Publication Batches, Publication Batch Items, _Workflow B Claim and one-unfinished-batch invariant. FAILED remains the current unfinished batch and must complete before another batch is prepared.

If `run` observes PUBLISHING at startup, return BATCH_ALREADY_PUBLISHING without writes or Telegram operations. Do not query the n8n API or infer whether a previous execution is alive. The operator must run only one publish execution at a time: this state check is not a compare-and-swap transaction covering simultaneous reads before either execution writes PUBLISHING. No new lock or lease is added to address that accepted operating constraint.

After a hard n8n/container crash leaves PUBLISHING, the operator must confirm in the n8n UI that no publication execution is running, manually delete all Telegram messages from that attempt, then manually change only that batch's status to FAILED and execute `run` from Manual Trigger. Do not automate this procedure or retry cached send/write nodes.

Workflow B has no publication ownership/takeover subsystem or n8n API credential. An existing `_Workflow B Publisher` tab is obsolete: ignore its contents, never read/validate/recreate it, and allow the operator to remove it manually. No migration or automatic deletion is required.

---

## 19. Human REJECT behavior

When the operator sets:

```text
human_decision = REJECT
```

the application is considered resolved.

Expected behavior:

- exclude from publication;
- remove from Review Queue projection;
- show in Archive projection;
- preserve Workflow A machine outcome;
- preserve canonical application history.

No Telegram action is taken.

No mandatory human rejection reason is required.

---

## 20. Human override of any Workflow A outcome

Any Workflow A outcome, including upstream error/rejection/review states, must remain visible to the human.

If the operator determines that the available data is sufficient, edits the row if needed, and sets:

```text
human_decision = PUBLISH
```

Workflow B may publish it if deterministic publication preflight passes.

Workflow B must not require a specific Workflow A status or a successful Workflow A rerun.

---

## 21. Configuration

Operational settings must be environment-driven and secret-free in source control.

The normal mode is `WORKFLOW_B_MODE=run`, also the default when unset/empty. Retain `setup` only for fresh-workbook bootstrap. Reject explicit legacy `prepare` and `publish` values with WORKFLOW_B_MODE_MIGRATION_REQUIRED and a clear one-time instruction to set `run` and reload the n8n runtime environment. Never silently reinterpret an existing `prepare` configuration as permission to send. After this migration, normal publication and manual full retries require no mode edits, workflow-node edits or n8n restart. A fresh bootstrap may switch once from `setup` to `run`.

At minimum externalize:

- Google Spreadsheet identifier;
- canonical Applications tab name;
- Review Queue projection/tab name;
- Archive projection/tab name;
- Control tab name;
- Publication Batches tab name;
- control checkbox/cell location if applicable;
- fixed numeric Telegram channel/chat identifier;
- expected Telegram bot identity;
- public Telegram channel username if required to construct post URLs;
- publication description maximum;
- Telegram credential ID/name references;
- Workflow B/config version identifiers.

Do not commit Telegram bot tokens or credential secrets.

Use the same environment-agnostic credential-reference approach established in Workflow A.

---

## 22. n8n architecture constraints

Workflow B should be implemented as one business workflow for MVP.

Recommended internal stages:

```text
1. Trigger / control read
2. Active-batch detection / claim
3. Read latest application rows
4. New-batch selection
5. Deterministic preflight
6. Sort + assign batch positions
7. Freeze batch snapshot
8. Complete whole-batch transport preflight, then send START
9. Sequential vacancy publication
10. Send END
11. Persist completion
12. Reset/finish control state
```

A fresh `run` execution inspects unfinished batches before considering new creation. If none exists, follow §9 checkbox creation and durable confirmation, then join the same publication path within this execution. Stop after this one batch. PUBLISHING returns BATCH_ALREADY_PUBLISHING. CREATED or FAILED runs full preflight, atomically prepares delivery state, then starts at sequence zero. The operator cleans all messages from a failed attempt before retrying. No separate recovery control or n8n API credential is required.

Do not create Workflow C for MVP.

Keep Workflow B inactive by default during implementation.

Use the repository's established builder-generated n8n workflow pattern rather than hand-maintaining exported JSON.

Target the same canonical n8n runtime conventions as Workflow A unless explicitly changed.

---

## 23. Repository structure

Recommended new files:

```text
WORKFLOW_B_IMPLEMENTATION_SPEC.md
docs/WORKFLOW_B_DECISIONS.md
docs/WORKFLOW_B_IMPLEMENTATION_STATUS.md
n8n/build-workflow-b.mjs
n8n/workflow-b.test.mjs
n8n/workflow-b.json            # generated artifact according to repository policy
```

Additional focused helper/test modules may be created where they improve maintainability.

Workflow B implementation should avoid unnecessary changes to Workflow A code and documentation.

The dependency direction is:

```text
Workflow B depends on Workflow A output contract.
Workflow A must not depend on Workflow B.
```

---

## 24. Decision log policy

`docs/WORKFLOW_B_DECISIONS.md` should contain implementation decisions that are necessary but not already defined by this canonical spec.

Examples:

- exact Sheet claim/mutex mechanism;
- exact frozen snapshot storage layout;
- exact Telegram node/API mechanism;
- details-link selection rule if upstream fields are ambiguous;
- exact Review Queue / Archive projection implementation.

Do not use the decision log to silently change business rules defined here.

If implementation reveals a product-policy ambiguity, amend this canonical spec first.

---

## 25. Implementation milestones

The implementation may be organized approximately as follows.

### M0 — Canonical specification and project boundary

- finalize this spec;
- create Workflow B decision/status files;
- establish builder/test skeleton;
- confirm no Workflow A implementation duplication.

### M1 — Deterministic domain model

Implement and test:

- human-decision handling;
- publication-order validation;
- batch selection;
- batch-position assignment;
- deterministic renderer;
- publication-length preflight;
- publication state model;
- frozen snapshot model.

No live Google/Telegram integration required.

### M2 — Google Sheets review/control integration

Implement and test:

- current row reads;
- control surface;
- Review Queue / Archive projections;
- batch persistence;
- application publication fields;
- active-batch claim.

No live Telegram publication required.

### M3 — Telegram publication path

Implement and mock-test:

- START send;
- sequential vacancy send;
- END send;
- exact numbering/rendering;
- per-message acknowledgement persistence;
- complete O-006 transport preflight and HTML escaping;
- deterministic failure stopping, including rate limits; no automatic Telegram retry.

Controlled M3 manual testing must prohibit concurrent publishers operationally. Resolved requirements do not themselves authorize live sends.

### M4 — Manual whole-batch restart

Implement and test full frozen-batch preflight, atomic delivery-only reset of FAILED batches, sequence-zero retry, PUBLISHING startup no-op, completed-history protection, stop-on-failure including 429, manual crash recovery documentation, and removal of all superseded publication coordination and partial-retry machinery. Preserve M0–M3 content/prepare contracts. Do not implement M5/M6 in this simplification.

### M5 — Integrated workflow verification

Verify:

- complete generated workflow;
- canonical n8n import/runtime compatibility;
- environment configuration;
- credential-reference generation;
- complete mocked end-to-end batch scenarios;
- no LLM/OpenAI nodes or calls;
- no secret leakage.

### M6 — User-operated non-production verification

After explicit operator approval:

- configure non-production Telegram destination;
- configure test Google Sheet;
- run one single-vacancy batch;
- run one multi-vacancy batch;
- validate Archive/Review Queue result;
- test one controlled manual cleanup/full-retry scenario if safe.

No production activation is implied by M6 completion.

Server installation (Workflow A Section 22.1) does not change this: the first server runs use the test channel, and the production switch is the user's.

---

## 26. Required test coverage

At minimum, automated tests must cover:

1. blank/PUBLISH/REJECT human decisions;
2. publication does not depend on a fixed Workflow A machine-status enum when human=PUBLISH and publication fields are valid;
3. REJECT rows excluded from publication;
4. blank rows remain unresolved;
5. manual publication ordering;
6. missing publication_order;
7. duplicate publication_order;
8. gaps in order accepted;
9. latest Sheet edits used when creating a new batch;
10. batch snapshot frozen after creation;
11. any publication-relevant Sheet edit made before batch creation is reflected in the frozen snapshot;
12. Sheet edits made after snapshot creation do not alter the active batch;
13. exact START → N vacancy posts → END sequence;
14. one-vacancy batch still sends START + one vacancy + END;
15. exact `·N·` numbering;
16. blank line after numbering;
17. numbering reset for each new batch;
18. no historical `remote` suffix;
19. deterministic body renderer;
20. configured description-length preflight;
21. no silent truncation;
22. no LLM/OpenAI node/call;
23. adverse/non-ready Workflow A machine outcomes can be overridden by human PUBLISH;
24. Workflow B remains publishable when a new/unknown upstream machine status is introduced, provided human=PUBLISH and preflight passes;
25. message ID persisted after each successful Telegram send;
26. vacancy N failure stops all later sends and marks FAILED;
27. END failure requires cleanup and a full retry from START;
28. retry clears all delivery state only after successful preflight;
29. acknowledgement uncertainty fails the attempt and requires manual Telegram cleanup;
30. completed applications cannot be republished accidentally;
31. two concurrent triggers cannot claim the same rows;
32. unfinished active batch prevents overlapping new batch creation;
33. canonical Applications rows are not physically moved/deleted;
34. Review Queue projection hides resolved rows;
35. Archive projection includes rejected/published rows;
36. Telegram URL metadata is persisted when constructible;
37. generated workflow contains no secrets;
38. generated workflow imports into the canonical n8n runtime;
39. workflow remains inactive by default;
40. HTML escaping of all application text, renderer-only formatting, normal notifications and disabled link previews;
41. every O-006 transport preflight failure prevents all sends, including START;
42. successful acknowledgements require message_id and are persisted before advancing, with atomic vacancy/Application metadata updates where practical;
43. every FAILED retry sends START, all vacancies and END with unchanged frozen content;
44. every Telegram failure, including 429 with a supplied delay, stops without automatic retry or waiting;
45. PUBLISHING at startup returns BATCH_ALREADY_PUBLISHING with no sends or writes;
46. obsolete publication coordination sheets are ignored; no self-API, publication UUID, takeover or Telegram Wait node exists;
47. a completed `run` rerun with unchecked control returns INACTIVE with zero sends, no new batch and no unnecessary Sheet write;
48. O-008 correct/removed/stale links, repeated names, earliest unlinked mention and exact label refresh;
49. exact case-sensitive Unicode word boundaries, no trimming/normalization/alias inference, partial-label and cross-span ambiguity;
50. unrelated links, literal HTML, supported escapes, balanced/escaped parentheses, rejected unsupported syntax and invalid destinations;
51. post-insertion/refresh visible body length (Section 12), complete transport limits, whole-batch rejection before claim/write/START;
52. latest draft/selection/Project Link reads, source preservation, frozen retries after later edits, legacy formats and unknown/inconsistent format rejection;
53. missing required columns/selections produce correction diagnostics without automatic upstream field creation, LLM calls or project-page requests;
54. O-009 list recognition, all five markers, mixed lists, numbering/indentation/continuations, ambiguous punctuation and unchanged link destinations;
55. exact contact example, individual/multiple contacts, literal underscores, narrowly decoded username escapes, no inferred services or lost data, and idempotence;
56. original and derived snapshot data, historical format compatibility, unknown/mixed/inconsistent formats, immutable full retries, formatting/length failures before writes/sends, and current generated Code execution;
57. default `run`, explicit legacy-mode rejection before I/O, and separate bootstrap;
58. one-execution single/multi creation through END, no-candidates and invalid-candidate safeguards;
59. CREATED/FAILED frozen content despite later edits, retained CREATED on publication preflight failure, and failed retry preflight preserving delivery evidence;
60. same-ID durable creation confirmation, unresolved writes stopping, and a different creation-claim winner stopping without publication;
61. at most one batch per execution, including existing-batch completion with checked control/additional eligible rows, and zero startup PUBLISHING writes/Telegram operations even with a checked control.
62. O-010 submitted-link representation: trimmed, Markdown-wrapped and bare-domain Project Link and Original Link values pass, absolute URLs stay exact, still-invalid values keep their diagnostics, Applications cells stay unchanged and represented values are frozen;
63. presentation-v4 contacts: Telegram account URLs with and without scheme, `www.` and trailing slash become `@<username>` with supplied case and kept labels; invite, post and reserved Telegram paths stay unchanged; unspaced slash splitting only when every piece is recognized; bare tokens without `@` stay literal; frozen presentation-v3 and earlier contacts keep their formatter.
64. presentation-v5 contacts: whitespace splitting around username, email and URL anchors with phone spacing and labels kept together, no split when any piece is unrecognized or when phones are adjacent, redundant Telegram and email labels omitted while WhatsApp/Phone/Телефон labels stay, and frozen presentation-v4 contacts keep their formatter.

---

## 27. Acceptance criteria

Workflow B MVP is accepted when all of the following are true:

1. The human can review every application in Google Sheets.
2. The human can override any Workflow A machine outcome without Workflow B depending on a fixed upstream status enum.
3. The human can edit any publication-relevant Sheet field before batch creation, including the full publication body.
4. The human can explicitly choose PUBLISH/REJECT.
5. The human can control publication order.
6. One manual execution in `run`, with the creation control checked and no unfinished batch, creates exactly one batch from all current approved unpublished rows and publishes it through END; later retries require no configuration change.
7. The workflow uses latest Sheet data at batch creation.
8. The batch content is frozen before publication and remains immutable for that batch, including during full retry.
9. Telegram receives:
   - one START marker;
   - one numbered message per vacancy;
   - one END marker.
10. Each successful vacancy send is persisted immediately.
11. Partial failure stops; after operator cleanup, retry republishes the entire same frozen batch.
12. Retry runs full preflight before one atomic delivery-only reset. Runtime Telegram availability is not guaranteed.
13. Published/rejected rows disappear from Review Queue without deleting canonical history.
14. Published rows expose Telegram metadata in Archive.
15. No LLM semantic editing exists in Workflow B.
16. No production credential or secret is committed.
17. Full local/mocked regression suite passes.
18. The generated inactive workflow imports successfully into the canonical n8n environment.
19. A user-operated non-production test confirms one complete batch lifecycle.

---

## 28. Implementation decisions and resolved amendments

O-001 through O-005 below retain the original decision prompts; their resolutions are recorded in docs/WORKFLOW_B_DECISIONS.md (B-D004 through B-D009). O-006 is the user-resolved transport amendment dated 2026-09-17. O-007 below is the 2026-09-19 manual whole-batch restart amendment, which supersedes earlier recovery decisions. They are requirements, not evidence of implemented or live-verified behavior.

### O-001 — Exact Review Queue / Archive projection mechanism

After inspecting the existing workbook, choose the least fragile Google Sheets projection mechanism while preserving the canonical Applications dataset. Do not create a separate data-ownership layer.

### O-002 — Exact Control trigger mechanism

Need to choose the most reliable low-complexity checkbox/control pattern in n8n + Google Sheets.

### O-003 — Active batch claim / concurrency mechanism

Need a simple MVP-safe approach without introducing external coordination infrastructure.

### O-004 — Frozen snapshot item storage format

`Publication Batches` is the canonical batch-level store.

Need to choose the minimal durable representation for frozen per-vacancy batch content so that a failed batch can be republished without rebuilding content from mutable Applications.

### O-005 — Details-link selection rule

Need to inspect existing Workflow A canonical Project Link / Original Link semantics and choose the deterministic publication rule without duplicating or contradicting upstream logic.

### O-006 — Telegram transport

**Status:** Resolved.

#### Transport

Workflow B publishes to exactly one fixed Telegram channel using the existing Telegram bot.

* The destination is identified internally by a fixed numeric `chat_id`.
* The bot has only the permissions required to publish messages.
* Publication uses the native n8n Telegram node unless testing demonstrates that it hides information required for correct acknowledgement/error handling.
* Messages are sent strictly sequentially:

`START → vacancy 1 → vacancy 2 → ... → vacancy N → END`

* Normal Telegram notifications are used.
* Link previews are disabled.
* Workflow B never automatically deletes or edits already published messages.

#### Formatting

Telegram messages use HTML parse mode.

O-008 explicitly supersedes the earlier rule that all description Markdown is literal: supported inline description links in new snapshots become renderer-generated HTML anchors. O-009 additionally supersedes literal list/contact preservation only for its new snapshot format. All other text, including user HTML and contact Markdown, remains literal and is HTML-escaped. Existing frozen formats retain their established behavior.

Only the deterministic Workflow B renderer may introduce supported HTML formatting such as bold text or hyperlinks.

User/application text must never be interpreted as arbitrary HTML.

#### Transport preflight

Before sending `START`, Workflow B performs a complete preflight of the entire batch.

Preflight must verify everything under Workflow B's control, including:

* the frozen batch is internally consistent;
* all `START + N vacancies + END` messages have already been deterministically rendered;
* all payloads satisfy Telegram size constraints;
* generated HTML is valid according to the renderer contract;
* publication links are valid;
* Telegram credentials work;
* the expected bot identity is being used;
* the configured numeric channel ID is correct;
* the bot currently has permission to publish to the channel;
* link previews are disabled;
* all required transport configuration is present.

If any preflight check fails, **nothing is sent to Telegram**.

Preflight is not expected to prove that Telegram itself is currently available or that a future network request cannot fail.

#### Acknowledgement

A Telegram message is considered successfully published only after Telegram returns a successful acknowledgement containing the resulting `message_id`.

After every successful send, Workflow B persists the corresponding acknowledgement before proceeding to the next message.

All related Google Sheets acknowledgement fields for one vacancy are persisted in one atomic `spreadsheets.batchUpdate` request where practical, including the item state, Telegram message ID/URL, publication timestamp, and corresponding canonical Applications metadata.

---

### O-007 — Manual whole-batch publication recovery

**Status:** Resolved by the 2026-09-19 product decision. Sections 15–18 are the complete current contract. Earlier recovery designs are superseded.

After any failed attempt, the operator cleans its Telegram messages and retries the entire same frozen batch from START. Preflight must pass before the atomic delivery reset. No partial resume, publication ownership/takeover, self-API calls, automatic retry/deletion, reconciliation or new recovery controls are implemented. See B-D014.

---

### O-008 — Deterministic project-name hyperlinks (2026-09-20)

**Status:** Authorized narrow amendment integrated after M5; M6/live-service work remains separately authorized. This contract takes precedence over older literal-Markdown and raw-draft length statements.

#### Small parsing contract

Support plain text plus inline links `[visible label](destination)` only. Backslash escapes decode exactly these ASCII characters in text, labels and destinations: backslash, `[`, `]`, `(`, `)`, `&`, and `!`. Unknown backslash sequences stay literal. Escape a literal exclamation mark before a link as `\!` to distinguish it from an unsupported image; insertion adds any necessary boundary escapes while preserving visible text. Do not decode HTML entities, percent escapes or Unicode normalization. Literal brackets must be escaped; unescaped brackets are reserved for complete inline links. A label must contain usable nonblank text, cannot nest brackets and cannot span CR/LF lines. Destinations accept balanced unescaped parentheses (including nested pairs) and escaped literal parentheses; the first unmatched unescaped closing parenthesis ends the destination. Destinations must pass the shared HTTP(S) policy below.

Reference links, images, titles, nested links, angle-delimited destinations and incomplete/unbalanced link structures are unsupported and fail with a formatting correction. Other Markdown features (emphasis, headings, etc.) and all user HTML remain literal under the escaped-text policy. This is a deliberately limited grammar, not CommonMark or a general formatting framework. For example `\[literal\]` in source notation with one escape before each bracket displays literal brackets; operators should enter `\\` when they intend a visible backslash.

#### Exact matching and rendering

Parse the body to visible text, excluding destinations and link syntax. Treat `project_link_text` as the exact visible string, not another Markdown input. Match case-sensitively after decoding the supported body presentation escapes. Do not trim the selection, normalize Unicode, infer aliases or use fuzzy matching. When the first/last selection character is a Unicode letter (`L`), number (`N`), combining mark (`M`) or underscore, it must not touch another such character outside that boundary.

Choose the earliest valid occurrence. Repetition alone is allowed. That occurrence must lie wholly inside one unlinked span or equal the entire visible label of one inline link. If it crosses a link boundary or selects only part of a link label, fail **at that occurrence**, even if a later occurrence would be usable. Do not skip an ambiguous earliest occurrence.

For the selected occurrence only: leave an already correct link byte-for-byte unchanged in canonical Markdown; wrap an unlinked occurrence once; or replace only the existing destination when it differs from current Project Link. Preserve wording, punctuation, unrelated supported links and later repeated mentions. Never nest or duplicate wrappers. No derived changes may be written to Applications draft, final, identity or source fields.

Convert each supported body link into Telegram `<a href="...">...</a>` in HTML mode. Escape literal text and labels (`&`, `<`, `>`, `"`) and attribute values; never interpret user HTML. Preserve the existing numbering, blank-line/boundary-line handling, Original Link “Детали”, contact, notifications and disabled previews.

#### Shared structural URL policy

Reuse the existing O-006 transport policy for Project Link and supported body links, with no URL normalization or reachability check. It requires HTTP(S), a nonempty authority without user-info, Unicode-letter/number hostname endpoints and letter/number/dot/hyphen interior (no consecutive dots), or the existing bracketed hex/colon address syntax; an optional decimal port must be 1–65535. Reject whitespace, controls, literal backslashes/angle brackets, malformed authority and malformed percent escapes. This is the inherited string-based policy, not DNS validation or exhaustive host/address validation. Well-formed publication Unicode is also required for HTML encoding.

Preserve the supplied destination exactly, including scheme/host case, explicit port, path, percent-encoding, query order, repeated/empty parameters, ampersands and fragments. Presentation escapes for parentheses/backslashes/ampersands must decode to the exact supplied destination. Do not trim, remove parameters, decode/re-encode, resolve DNS, fetch the URL or test reachability. Original Link remains the separate details destination and has no fallback relationship to Project Link.

#### Preflight and immutable formats

Before any new-batch persistence, validate every selected row's existing approval/eligibility/order, usable draft, nonempty selection, Project Link, safe supported syntax, earliest occurrence, selected hyperlink destination, visible length of the canonical Markdown body after updating the link (Section 12), and complete deterministic Telegram transport. Failure returns no partial prepared list or write plan. Diagnostics identify the application/row and how to correct it: missing/invalid Project Link, missing selection, selected text no longer occurring, ambiguous formatting, or publication/transport length overflow. Missing upstream columns stop with a named-column correction; Workflow B never creates/populates them.

Freeze the exact source draft separately from the canonical derived Markdown publication body, the unchanged Project Link, exact selection and format discriminator in the existing durable item snapshot. Persist the exact complete Markdown message too, and reconstruct/check it using only those frozen inputs. Do not persist offsets or add a second editable source. The concrete minimal column layout and version are B-D015.

Existing blank-discriminator snapshots retain the two previously recognized exact assembly formats (O-005 and pre-O-005). Reconstruction never retrofits project links or reads mutable Applications to fill missing legacy metadata. O-005 legacy publication keeps description Markdown literal; pre-O-005 free-form details remain reconstructable but retain the established transport rejection. Unknown versions, mixed versions inside one batch, nonblank link metadata with no version, or disagreement between original draft, selection, destination, derived body and complete rendered message fail explicitly. Deployment workflow/config labels remain separate from the content discriminator because operators can override them.

Existing item rows and delivery evidence remain unchanged. A valid new-batch commit may append only missing B snapshot headers atomically with the M2 creation claim and all new rows; it must not rewrite historical cells. Legacy publish/retry works without those new headers. Preserve the whole-batch reset and all manual recovery requirements in §§17–18: preflight every frozen payload, Application target and destination before any delivery-only reset/send; failed preflight preserves evidence; retries start at START; PUBLISHING returns BATCH_ALREADY_PUBLISHING; crash-stuck recovery remains manual n8n UI verification, cleanup, then FAILED. No partial resume, self-API lookup, ownership/takeover, automatic retry/deletion or recovery controls.

#### Human semantic and verification boundary

Human review must confirm that `project_link_text` selects the earliest **semantic** project mention in the latest draft. If an operator adds an earlier abbreviation or changes project wording, they must update the selection. Code verifies only the earliest valid exact substring and cannot identify every semantic reference. A structurally valid hyperlink proves neither reachability nor project ownership. Human `PUBLISH` remains required; machine status alone must not block publication, no successful worker fetch is required for formatting, and no machine outcome changes. Workflow B makes no LLM or project-page calls.

---

### O-009 — Deterministic list and contact presentation (2026-09-21)

**Status:** Explicitly authorized narrow amendment. It does not authorize M6 or live-service work. Workflow A owns editorial content and contact eligibility; B performs only the following deterministic presentation, using the latest approved Applications values when creating a NEW batch. No LLM, shortening, semantic editing, new headline, service inference or eligibility rule.

#### Unordered lists

Render a recognized item prefix as the literal Unicode bullet plus one space: “• ”. Keep original indentation, wording, order, trailing whitespace, continuation lines, line endings and paragraph boundaries. Support source markers *, -, –, — and • followed by horizontal whitespace and nonblank content, at the start of a physical line after optional spaces/tabs.

Recognition is deliberately conservative:

- A • marker is explicit. Other markers need either an immediately preceding colon-terminated heading at the same or a shallower indentation, or a run of at least two items with identical indentation containing at least one * or • marker.
- A run may contain deeper-indented continuation lines or nested items. A blank line or unrelated line at the same/shallower indentation ends the run. Each nested indentation is considered independently.
- Separator-only content is not an item. For markers other than •, digit-leading content (optionally preceded by +, - or −) is ambiguous numeric prose and stays unchanged. Preserve numbered lists, negative numbers, isolated asterisk notes, emphasis, multiplication, sentence dashes and hyphenated words.
- Unheaded dash-only runs remain unchanged because they can be dialogue or prose. Do not infer list items or restructure text to remove that ambiguity.

Apply this after the existing O-008 project-link transformation. Supported link labels/destinations are single-line; only literal raw line prefixes outside links change. Keep all link labels and decoded destinations intact. Repeated presentation is idempotent. O-008 exact matching, earliest occurrence, ambiguity/escaping and URL policy remain unchanged.

#### Contacts

Keep the adapter mapping from **Contact Info**. Freeze its exact original value as contact. Derive publication_contact separately and add exactly one outer “Контакт: ” during assembly. Remove only leading copies of that outer label. An outer label with no usable remaining text uses the existing INVALID_CONTACT formatting diagnostic; it is not a contact eligibility decision.

For confidently recognized components, remove the colon after the service label, keep the supplied label spelling/case, and join components with “ | ”. Supported explicit labels are WhatsApp, Telegram, Телеграм, Email/E-mail, Почта, Phone and Телефон (case-insensitive recognition). Recognize phone strings made of digits, optional leading +, spaces, parentheses and hyphens; plain email addresses; structurally valid HTTP(S) addresses; and standalone or Telegram-labeled @usernames with an ASCII letter followed by 4–31 ASCII letters/digits/underscores. These are formatting recognizers, not new validity/eligibility gates: all unrecognized nonblank text remains publishable under the existing structural/transport checks.

Preserve a recognized component's accompanying parenthetical note or space-separated en/em-dash note. Normalize component separators only when **every** separated piece is recognized: vertical bars, newlines, commas/semicolons followed by horizontal whitespace, and (presentation-v2) horizontal whitespace before an explicit supported service label followed by a colon. Preserve full URLs and meaningful notes. If boundaries or contents are ambiguous, keep the input body unchanged after removing the outer wrapper; never drop an unrecognized piece. No new ambiguity diagnostic, business rejection or operator control is introduced.

Keep order, phone digits, international +, internal phone spacing, usernames, email/URL addresses and notes. Never infer WhatsApp or add any label/contact. In confidently recognized standalone or Telegram-labeled username tokens only, decode a backslash immediately before an underscore; any other backslash prevents that token's normalization. No global backslash removal or Markdown escaping. Contact Markdown/HTML otherwise stays literal and is HTML-escaped; no new contact hyperlinks are required.

Example source:

    Контакт: WhatsApp: +62 811 1234 5678; Telegram: @Example\_HR

Exact visible contact section:

    Контакт: WhatsApp +62 811 1234 5678 | Telegram @Example_HR

#### Contact correction from executions 115/116 (2026-09-21)

For new presentation-v3 snapshots, horizontal spacing includes Unicode space separators (notably U+00A0 NBSP and U+202F) and tabs. Accept these around labels and boundaries; preserve their exact spelling inside phone numbers and notes. Add the explicit Telegram alias ТГ (case-insensitive), keeping its supplied spelling. A slash surrounded by horizontal whitespace is a component delimiter only when all pieces are recognizable; never split a standalone URL's path.

After an exact recognized contact token, preserve an accompanying plain-text suffix consisting of Unicode letters/marks and horizontal spaces (for example Галина) without inferring or rewriting its meaning. Continue preserving parenthetical/dash notes. Decode a single backslash before @ only inside a fully recognized email token, and the existing backslash-underscore escape only inside a recognized username. Other backslashes and unknown pieces remain literal; no global cleanup or deduplication.

Real execution examples (the spaces after service colons and before the slash were U+00A0):

    WhatsApp: +62 811 1234 5678  Telegram: @Example_HR
    → Контакт: WhatsApp +62 811 1234 5678 | Telegram @Example_HR
    m.recruiter@example.org  / ТГ @recruiter_hr Галина
    → Контакт: m.recruiter@example.org | ТГ @recruiter_hr Галина

#### Frozen formats, limits and recovery

New items use **snapshot_version=presentation-v3**. The 2026-09-21 screenshot correction additionally recognizes horizontal whitespace before an explicit supported service label followed by a colon, when every resulting component is recognized. Preserve standalone URLs and recognized accompanying notes; unknown or unlabeled boundaries remain unchanged. Existing **presentation-v1** snapshots retain the original delimiter-only contact formatting for validation and retry; existing **presentation-v2** snapshots retain ASCII-space recognition and their original unformatted NBSP/slash/ТГ inputs. Neither historical version receives v3 normalization. Preserve draft_description, contact, Project Link, Original Link, identity and raw Applications inputs unchanged. Reuse publication_description for the final derived linked/list body and append only publication_contact to the B item layout. Store the complete rendered_text and validate all derived fields against the original frozen inputs on reconstruction.

Blank-version legacy formats and **project-links-v1** keep their exact established rendering; list/contact changes never apply retroactively. Old items may lack publication_contact or have a blank cell, but may not carry a nonblank new-format contact. Unknown, mixed or inconsistent formats stop through existing snapshot consistency handling. A new-batch atomic commit appends missing B headers if necessary; no old-row rewrite or backfill.

Retain §12 limits, validating the full final transport before persistence. Retry reconstructs solely from frozen data despite later Applications edits. Preserve every §17–18 preflight, delivery-only atomic reset, M2 creation claim, PUBLISHING block and manual cleanup/full-restart rule. “Детали” still derives its label from Original Link and keeps the complete destination.


### O-010 — Submitted-link representation and contact presentation (2026-10-08)

**Status:** Authorized narrow amendment for new snapshots only. No LLM, semantic editing, eligibility rule or operator control is added.

#### Submitted links

When creating a NEW batch, read Project Link and Original Link through Workflow A's shared submitted-link representation (Workflow A Stage 0 and Stage 1): trim surrounding whitespace, unwrap a complete simple Markdown link, and prefix `https://` to a whole plausible bare domain. A value that is already an absolute HTTP(S) URL keeps its scheme, host case, path, query and fragment exactly. The represented value then passes the existing O-005, O-006 and O-008 structural checks; a value that is still not a valid absolute HTTP(S) URL fails with the existing INVALID_PROJECT_LINK or INVALID_DETAILS_LINK diagnostic. Applications cells are never rewritten. The snapshot freezes the represented values as project_link and details_link, and retries reuse them. This narrowly supersedes "full unchanged Original Link URL" (O-005) and "preserve the supplied destination exactly" (O-008) for this representation step only.

#### Contacts (presentation-v4)

O-009 contact presentation and its 2026-09-21 correction apply, with two additions:

1. A component that is exactly a Telegram account URL — `t.me/<username>` or `telegram.me/<username>`, with or without `http://`/`https://` and `www.`, with at most one trailing `/` and no further path, query or fragment — where `<username>` matches the recognized username pattern and is not a path Workflow A treats as reserved, is presented as `@<username>` with the supplied case. Telegram presents such a mention as a link to the account; no HTML anchor is added. A supported Telegram label before it is kept. Other Telegram URLs (invite links, message or post links, reserved paths) remain unchanged.
2. A slash without surrounding whitespace is also a component delimiter, only when the whole body is not itself a recognized component and every separated piece is recognized.
3. (presentation-v5) Horizontal whitespace is also a component delimiter around anchor tokens: a whitespace-separated token that is by itself a recognized `@username`, email address, HTTP(S) URL or Telegram account URL. A supported service-label token belongs to the token after it, and other consecutive non-anchor tokens are rejoined with their original whitespace into one piece, so internal phone spacing stays unchanged. The split applies only when the whole body or delimited piece is not itself a recognized component and every resulting piece is recognized; otherwise the piece stays unchanged.
4. (presentation-v5) Redundant service labels are omitted: a Telegram, Телеграм or ТГ label before a component presented as `@username`, and an Email, E-mail or Почта label before an email address. WhatsApp, Phone and Телефон labels, and any label before another kind of component, are kept as O-009 specifies.

Nothing else is inferred: a bare token without `@` is not a username, and the operator corrects such a Contact Info value during review.

presentation-v4 examples (rules 1 and 2):

    https://t.me/Jobdesk1                 → Контакт: @Jobdesk1
    Telegram: t.me/Jobdesk1               → Контакт: Telegram @Jobdesk1
    @Ms_example/hiringdesk@school.test    → Контакт: @Ms_example | hiringdesk@school.test
    Ms_example/hiringdesk@school.test     → Контакт: Ms_example/hiringdesk@school.test
    https://t.me/+AbCdEfGh                → Контакт: https://t.me/+AbCdEfGh

presentation-v5 examples:

    Telegram: @user_name hr@school.test             → Контакт: @user_name | hr@school.test
    @Anna_Example aexample@mail.test                → Контакт: @Anna_Example | aexample@mail.test
    +7 999 123-45-67 @user_name                     → Контакт: +7 999 123-45-67 | @user_name
    WhatsApp: +62 811 1234 5678 Telegram: @Example_HR → Контакт: WhatsApp +62 811 1234 5678 | @Example_HR
    @recruiter_hr Галина                            → Контакт: @recruiter_hr Галина

#### Versions and frozen batches

New snapshots used snapshot_version `presentation-v4` for rules 1 and 2 and use `presentation-v5` since rules 3 and 4; the defaults become `WORKFLOW_B_VERSION=workflow-b-presentation-v5` and `WORKFLOW_B_CONFIG_VERSION=presentation-v5`. Frozen presentation-v4 and earlier snapshots keep their contact formatter and frozen links for validation and retries (presentation-v3 and earlier also keep their unrepresented links). Unordered lists, Section 12 size policy, transport checks and manual whole-batch restart are unchanged.

---

## 29. Relationship to the final Workflow A amendment

Workflow A is expected to receive one final narrow publication-facing amendment before its contract is frozen:

- nullable `role_title`;
- nullable `employer_name`;
- nullable, operator-editable `project_link_text` under the authorized O-008 integration contract;
- no emoji in persisted `draft_description` or `final_description`;
- configurable publication-length guidance/maximum for normal publishable outputs;
- publication-ready natural opening inside the description when appropriate.

Workflow B must not depend critically on `role_title`, `employer_name`, or a fixed Workflow A machine-status enum.

Workflow B must rely on:

```text
draft_description
```

as the human-editable publication body before batch creation.

The local Workflow A documents may predate O-008. For this narrow task the supplied upstream contract is authorized; upstream implementation must not be claimed verified without committed evidence. Do not modify Workflow A files, copy uncommitted upstream work, merge or rebase. The following original future integration order is historical planning, not authorization for this task:

```text
Workflow A final amendment
        ↓
merge to main
        ↓
Workflow B rebase/merge onto updated main
        ↓
full regression verification
```

---

## 30. Canonical examples

### 30.1 Three-vacancy batch

Telegram sequence:

```text
...start >>
```

```text
·1·

<vacancy 1 body>

Детали: <link>

Контакт: <contact>
```

```text
·2·

<vacancy 2 body>

Детали: <link>

Контакт: <contact>
```

```text
·3·

<vacancy 3 body>

Детали: <link>

Контакт: <contact>
```

```text
...end >>
```

### 30.2 One-vacancy batch

Still publish:

```text
...start >>
```

```text
·1·

<vacancy body>
```

```text
...end >>
```

### 30.3 Human override

Workflow A:

```text
machine_status = <any current or future machine outcome>
machine_reason = <upstream reason/evidence>
```

Human:

```text
human_decision = PUBLISH
publication_order = 20
```

If the current Sheet publication data passes deterministic Workflow B preflight, the application may be published.

The Workflow A machine decision remains unchanged for visibility and later analysis.

---

## 31. Source-of-truth hierarchy

For MVP, use the following conceptual hierarchy:

### Application facts / upstream machine decision

Workflow A canonical application row.

### Human publication decision

Google Sheets:

```text
human_decision
publication_order
```

### Human-edited publication data

Latest Sheet values for all publication-relevant fields, including:

```text
draft_description
project_link_text
Project Website Link
publication_order
Original Link (details)
contact
```

read at new-batch creation.

### Frozen publication content

Workflow B batch snapshot after successful preflight.

### Telegram delivery state

Workflow B publication metadata persisted after each send.

This separation prevents Workflow B from rewriting content after human approval while still allowing safe publication retries.

---

## 32. MVP anti-overengineering constraints

The implementation must satisfy the reliability contract above with the simplest architecture compatible with the existing repository and Google Sheets/n8n stack.

For MVP, do not introduce:

- Redis, Postgres, Kafka, or external queues;
- a generic state-machine framework;
- event sourcing;
- a custom admin application;
- a Telegram review bot;
- Apps Script unless Google Sheets + n8n cannot provide a reliable control path;
- duplicate canonical copies of application data;
- generalized abstractions not required by Workflow B tests or operational safety.

Prefer:

- deterministic helper functions;
- explicit small enums;
- one generated n8n business workflow;
- Google Sheets as operator and persistence surface;
- focused unit/integration tests;
- narrowly scoped implementation decisions documented in `WORKFLOW_B_DECISIONS.md`.

Frozen snapshots, sequential per-send persistence, whole-batch preflight and manual full retry remain required. Do not add publication states, recovery controls, reconciliation, ownership sheets, leases, execution polling, automatic Telegram deletion or retries. The M2 creation claim is preserved. The operator runs one publication attempt at a time and cleans all messages from a failed attempt before retrying.

---

**End of canonical specification v1.0**
