# EduJobs v2 on the server n8n

**English** | [Русский](#русская-версия)

Installation and operation of vers_2 on the existing n8n server (Workflow A spec, Section 22.1; Workflow B spec, 2026-10-24 amendment). General server operation, backups and emergency procedures are described in `/opt/n8n-project/RUNBOOK.md`.

Server: `root@<server-ip>`, Compose project `n8n-project` in `/opt/n8n-project`. It runs n8n 2.35.7 with Postgres, browserless v2.55.3 and the network `n8n-project_default`. The old "Workflow A/B" workflows on the server belong to an earlier generation and are left untouched.

## 1. What gets installed

| What | Where | Note |
| --- | --- | --- |
| `content-worker` | service in `/opt/n8n-project/docker-compose.override.yml`, sources in `/opt/n8n-project/vers2/worker` | no published ports, `mem_limit: 200m`, talks to `browserless` |
| v2 variables | block at the end of `/opt/n8n-project/.env` | template: [`deploy/server/server.env.example`](../deploy/server/server.env.example); no secrets |
| `EduJobs v2 · Vacancy Intake` | n8n, ID `edujobs-workflow-a` | Workflow A: one application per execution |
| `EduJobs v2 · Intake Trigger` | n8n, ID `edujobs-intake-trigger` | every 5 minutes finds added rows and calls Vacancy Intake for each, one at a time |
| `EduJobs v2 · Telegram Publisher` | n8n, ID `edujobs-workflow-b` | Workflow B, run manually only |

The override is loaded automatically, so the commands from the server RUNBOOK (`docker compose up -d --force-recreate` and others) affect the worker too. n8n does not depend on the worker: if the worker is unhealthy, n8n still starts.

## 2. Installation (run by the agent, each step after the user's "yes")

Commands with `ssh` run on the Mac from the repository root; all others run on the server in `/opt/n8n-project`.

1. Snapshot the workflows for later comparison, then back up:
   ```sh
   docker compose exec -T postgres psql -U n8n -d n8n -At -c 'select id, name, active, "activeVersionId", "updatedAt" from workflow_entity order by id' > vers2-workflows-before.txt
   ./backup.sh
   cp docker-compose.yml docker-compose.yml.pre-vers2-$(date +%Y%m%d_%H%M%S)
   cp .env .env.pre-vers2-$(date +%Y%m%d_%H%M%S)
   ```
2. Copy the worker of the committed revision (from the Mac):
   ```sh
   git archive HEAD worker | ssh root@<server-ip> 'mkdir -p /opt/n8n-project/vers2 && rm -rf /opt/n8n-project/vers2/worker && tar -x -C /opt/n8n-project/vers2'
   scp deploy/server/docker-compose.override.yml root@<server-ip>:/opt/n8n-project/docker-compose.override.yml
   ```
3. Append the block from `deploy/server/server.env.example` to the end of `.env` (leave the `GOOGLE_SHEETS_*` lines empty) and check the substitution:
   ```sh
   docker compose config --quiet && docker compose config | grep -E 'content-worker|N8N_BLOCK_ENV|WORKFLOW_B_TELEGRAM_CHAT_ID'
   ```
4. Build and start the worker, then recreate only n8n (about a minute of downtime; postgres and browserless are not touched). The old active Workflow A runs at :00, :15, :30 and :45 and takes about a minute and a half; restart n8n between its runs and only when no execution is in progress:
   ```sh
   docker compose exec -T postgres psql -U n8n -d n8n -At -c "select count(*) from execution_entity where status in ('running', 'new', 'waiting')"
   ```
   Then:
   ```sh
   docker compose build content-worker
   docker compose up -d content-worker
   docker compose up -d --no-deps n8n
   ```
5. Checks:
   ```sh
   docker compose ps
   docker compose exec -T n8n node -e "fetch('http://content-worker:8000/health').then(r=>r.text()).then(console.log)"
   docker compose exec -T content-worker python -c "import urllib.request; print(urllib.request.urlopen('http://browserless:3000/active', timeout=3).status)"
   docker compose exec -T n8n sh -c 'env | grep -E "^(N8N_BLOCK_ENV_ACCESS_IN_NODE|CONTENT_WORKER_URL|WORKFLOW_B_MODE)="'
   docker compose logs --tail 30 n8n
   free -h
   ```
   Expected: `{"status":"ok"}`, then `204`, then the three variables. The n8n logs must show the old active workflow activated again.
6. After the user has created the credentials, read their IDs (secrets are not printed):
   ```sh
   docker compose exec -T postgres psql -U n8n -d n8n -c 'select id, name, type from credentials_entity order by name'
   ```
7. Build the workflows on the Mac with these IDs, copy them to the server and import them inactive into the owner's personal project:
   ```sh
   mkdir -p /tmp/edujobs-v2 &&
   env -i PATH="$PATH" N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID=<id> N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_NAME="<name>" N8N_OPENAI_CREDENTIAL_ID=<id> N8N_OPENAI_CREDENTIAL_NAME="<name>" node n8n/build-workflow.mjs /tmp/edujobs-v2/workflow-a.json &&
   env -i PATH="$PATH" N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID=<id> N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_NAME="<name>" N8N_TELEGRAM_CREDENTIAL_ID=<id> N8N_TELEGRAM_CREDENTIAL_NAME="<name>" node n8n/build-workflow-b.mjs /tmp/edujobs-v2/workflow-b.json &&
   ssh root@<server-ip> 'mkdir -p /opt/n8n-project/vers2/workflows' &&
   scp /tmp/edujobs-v2/workflow-a.json /tmp/edujobs-v2/workflow-a-intake-trigger.json /tmp/edujobs-v2/workflow-b.json root@<server-ip>:/opt/n8n-project/vers2/workflows/
   ```
   On the server:
   ```sh
   project=$(docker compose exec -T postgres psql -U n8n -d n8n -At -c "select id from project where type = 'personal'")
   for f in workflow-a.json workflow-a-intake-trigger.json workflow-b.json; do
     docker compose cp "vers2/workflows/$f" "n8n:/tmp/$f" &&
     docker compose exec -T n8n n8n import:workflow --input="/tmp/$f" --projectId="$project" &&
     docker compose exec -T -u root n8n rm -f "/tmp/$f" || break
   done
   ```
8. Comparison: the three new workflows have `active = f` and an empty `activeVersionId`; all others match `vers2-workflows-before.txt`:
   ```sh
   docker compose exec -T postgres psql -U n8n -d n8n -At -c 'select id, name, active, "activeVersionId", "updatedAt" from workflow_entity order by id' > vers2-workflows-after.txt
   diff vers2-workflows-before.txt vers2-workflows-after.txt
   ```
   The `diff` must show only the three added rows.

## 3. Going live (done by the user)

1. **Credentials** in n8n. The existing `Google Service Account account` (the new workbook is shared with its email as Editor) and `Telegram account` (the production bot of the `@edujobs` channel, ID `<production-bot-id>`) are reused; only OpenAI needs a new one (`EduJobs v2 · OpenAI`, with access to `gpt-6-luna`). The bot is an administrator of both the test and the production channel; its ID goes into `WORKFLOW_B_TELEGRAM_EXPECTED_BOT_ID`. Workflow B calls Google through HTTP Request nodes, so `Google Service Account account` must have **Set up for use in HTTP Request node** enabled with the scope `https://www.googleapis.com/auth/spreadsheets`; without it requests go out without a token and Google answers 403 "Method doesn't allow unregistered callers". This switch does not affect the Google Sheets nodes of the old workflows.
2. **Workbook.** Row 1 of the applications tab holds exactly the form headers `Timestamp`, `Short Description`, `Project Website Link`, `Original Link`, `Contact Info`, followed by the derived Workflow A columns ([LOCAL_SANDBOX, section 5](LOCAL_SANDBOX.md#5-prepare-the-non-production-sheet)). The old workflow's tabs (`Parced`, `Review` and their columns) must not coincide with this tab or with the Workflow B tabs (`Review Queue`, `Archive`, `Control`, `Publication Batches`, `Publication Batch Items`, `_Workflow B Claim`).
3. **Variables.** Set `GOOGLE_SHEETS_DOCUMENT_ID` and `GOOGLE_SHEETS_SHEET_NAME` in `/opt/n8n-project/.env`, then restart n8n: `docker compose up -d --no-deps n8n`.
4. **Workflow B bootstrap**, once per new workbook. It creates the Workflow B tabs and columns and publishes nothing:
   ```sh
   docker compose run --rm --no-deps -e WORKFLOW_B_MODE=setup n8n execute --id=edujobs-workflow-b
   ```
   Expected: `SETUP_COMPLETE`. The one-off container takes about 300 MB of additional memory while it runs.
5. **Publishing in n8n, strictly in this order:** first publish (Publish/Activate) `EduJobs v2 · Vacancy Intake`, then activate `EduJobs v2 · Intake Trigger`. n8n does not allow activating the trigger earlier: the called workflow must be published, and a call from an active workflow runs its published version. Leave `Telegram Publisher` inactive.
6. **Form.** Switch the Google Form to the new workbook. Rows that were already in the workbook when the trigger was activated are not processed automatically (section 4).

## 4. Routine operation

- **New application.** The form adds a row; within the next 5 minutes Intake Trigger finds its number and calls Vacancy Intake. The result is written to the same row.
- **Do not** delete, insert or sort rows in the applications tab: Intake Trigger recognizes new rows by their count.
- **An Intake Trigger error** (a red execution in n8n) lists the rows to process manually: `unlocated` — the row could not be found unambiguously, `failed_calls` — the Vacancy Intake call failed. All other rows of that poll were processed.
- **Manual processing of a row** (old rows, a repeat, a failure) uses a one-off container that runs the executable version from the database:
  ```sh
  docker compose run --rm --no-deps -e WORKFLOW_A_TEST_ROW_NUMBER=<row number> n8n execute --id=edujobs-workflow-a
  ```
  One command processes one row; start the next one after the previous has finished.
- **Publication:** review the rows, set `PUBLISH` and `publication_order`, enable the `Control!B2` checkbox, then click **Execute workflow** once on `EduJobs v2 · Telegram Publisher` in the n8n UI. Outcomes and recovery after a failure are described in the [Workflow B runbook](WORKFLOW_B_RUNBOOK.md).

## 5. Switching to the production channel

1. Make sure there is no unfinished batch (no `CREATED`, `FAILED` or `PUBLISHING` in `Publication Batches`) and that the bot is an administrator of the production channel.
2. In `/opt/n8n-project/.env`, replace `WORKFLOW_B_TELEGRAM_CHAT_ID` with the numeric ID of the production channel (`-100…`). Changing `WORKFLOW_B_CONFIG_VERSION` is also recommended, so that batches show the new configuration.
3. `docker compose up -d --no-deps n8n`; check: `docker compose exec -T n8n sh -c 'echo $WORKFLOW_B_TELEGRAM_CHAT_ID'`.

## 6. Updates

- **Worker code:** repeat step 2.2 (only `git archive …`) and `docker compose build content-worker && docker compose up -d content-worker`.
- **Workflows:** repeat steps 2.7–2.8. Import unpublishes and deactivates the imported workflows. Then repeat step 3.5 in order: publish Vacancy Intake, activate Intake Trigger. A reimported Intake Trigger starts counting rows from scratch: find rows added before its new activation by an empty `processing_status` and process them manually (section 4).
- **Variables:** edit `.env` and run `docker compose up -d --no-deps n8n`. After changing models or limits, change `CONFIG_VERSION` too.

## 7. Rollback

1. Deactivate `EduJobs v2 · Intake Trigger` and unpublish `EduJobs v2 · Vacancy Intake`; delete the three workflows in the UI if needed.
2. Remove the worker and the variables:
   ```sh
   mv docker-compose.override.yml vers2/docker-compose.override.yml.disabled
   cp .env.pre-vers2-<label> .env
   docker compose up -d --no-deps --remove-orphans n8n
   ```
3. Check that the old active workflow is active again: `docker compose logs --tail 30 n8n`.

The emergency deactivation of all workflows from the server RUNBOOK also unpublishes Vacancy Intake: repeat step 3.5 after it.

## 8. Monitoring

- Memory: `free -h` and `docker stats --no-stream`. The server has 2 GB of RAM; the worker is limited to 200 MB, and browserless processes one page at a time.
- Successful Vacancy Intake executions are saved (`EXECUTIONS_DATA_PRUNE`, `MAX_AGE=168` and `PRUNE_MAX_COUNT=1000` apply). If `execution_data` grows towards the alert threshold of the server RUNBOOK, disable saving of successful production executions in the Vacancy Intake settings. This setting is reset by a reimport.

---

## Русская версия

[English](#edujobs-v2-on-the-server-n8n) | **Русский**

Установка и эксплуатация vers_2 на существующем n8n (Workflow A spec, раздел 22.1; Workflow B spec, поправка 2026-10-24). Общая эксплуатация сервера, бэкапы и аварийные процедуры описаны в `/opt/n8n-project/RUNBOOK.md`.

Сервер: `root@<server-ip>`, Compose-проект `n8n-project` в `/opt/n8n-project`. Там n8n 2.35.7 с Postgres, browserless v2.55.3 и сеть `n8n-project_default`. Старые workflow «Workflow A/B» на сервере относятся к другому поколению: их не трогаем.

### 1. Что устанавливается

| Что | Где | Примечание |
| --- | --- | --- |
| `content-worker` | сервис в `/opt/n8n-project/docker-compose.override.yml`, исходники в `/opt/n8n-project/vers2/worker` | без портов наружу, `mem_limit: 200m`, ходит в `browserless` |
| Переменные v2 | блок в конце `/opt/n8n-project/.env` | образец — [`deploy/server/server.env.example`](../deploy/server/server.env.example); секретов нет |
| `EduJobs v2 · Vacancy Intake` | n8n, ID `edujobs-workflow-a` | Workflow A: одна заявка за выполнение |
| `EduJobs v2 · Intake Trigger` | n8n, ID `edujobs-intake-trigger` | раз в 5 минут ищет добавленные строки и по одной вызывает Vacancy Intake |
| `EduJobs v2 · Telegram Publisher` | n8n, ID `edujobs-workflow-b` | Workflow B, запускается только вручную |

Override подключается автоматически, поэтому команды из серверного RUNBOOK (`docker compose up -d --force-recreate` и другие) затрагивают и worker. n8n не зависит от worker: если worker нездоров, n8n всё равно стартует.

### 2. Установка (выполняет агент, каждый шаг — после «да» пользователя)

Команды с `ssh` запускаются на Mac из корня репозитория, остальные — на сервере в `/opt/n8n-project`.

1. Снимок workflow для последующей сверки, затем бэкап:
   ```sh
   docker compose exec -T postgres psql -U n8n -d n8n -At -c 'select id, name, active, "activeVersionId", "updatedAt" from workflow_entity order by id' > vers2-workflows-before.txt
   ./backup.sh
   cp docker-compose.yml docker-compose.yml.pre-vers2-$(date +%Y%m%d_%H%M%S)
   cp .env .env.pre-vers2-$(date +%Y%m%d_%H%M%S)
   ```
2. Скопировать worker закоммиченной ревизии (с Mac):
   ```sh
   git archive HEAD worker | ssh root@<server-ip> 'mkdir -p /opt/n8n-project/vers2 && rm -rf /opt/n8n-project/vers2/worker && tar -x -C /opt/n8n-project/vers2'
   scp deploy/server/docker-compose.override.yml root@<server-ip>:/opt/n8n-project/docker-compose.override.yml
   ```
3. Дописать в конец `.env` блок из `deploy/server/server.env.example` (строки `GOOGLE_SHEETS_*` оставить пустыми) и проверить подстановку:
   ```sh
   docker compose config --quiet && docker compose config | grep -E 'content-worker|N8N_BLOCK_ENV|WORKFLOW_B_TELEGRAM_CHAT_ID'
   ```
4. Собрать и запустить worker, затем пересоздать только n8n (простой около минуты; postgres и browserless не трогаем). Старый активный Workflow A запускается в :00, :15, :30 и :45 и работает около полутора минут; перезапускайте n8n между запусками и только при нуле выполнений в работе:
   ```sh
   docker compose exec -T postgres psql -U n8n -d n8n -At -c "select count(*) from execution_entity where status in ('running', 'new', 'waiting')"
   ```
   Затем:
   ```sh
   docker compose build content-worker
   docker compose up -d content-worker
   docker compose up -d --no-deps n8n
   ```
5. Проверки:
   ```sh
   docker compose ps
   docker compose exec -T n8n node -e "fetch('http://content-worker:8000/health').then(r=>r.text()).then(console.log)"
   docker compose exec -T content-worker python -c "import urllib.request; print(urllib.request.urlopen('http://browserless:3000/active', timeout=3).status)"
   docker compose exec -T n8n sh -c 'env | grep -E "^(N8N_BLOCK_ENV_ACCESS_IN_NODE|CONTENT_WORKER_URL|WORKFLOW_B_MODE)="'
   docker compose logs --tail 30 n8n
   free -h
   ```
   Ожидается `{"status":"ok"}`, затем `204`, затем три переменные. В логах n8n снова должен активироваться старый активный workflow.
6. После того как пользователь создал credentials, прочитать их ID (секреты не выводятся):
   ```sh
   docker compose exec -T postgres psql -U n8n -d n8n -c 'select id, name, type from credentials_entity order by name'
   ```
7. Собрать workflow на Mac с этими ID, отправить на сервер и импортировать неактивными в personal project владельца:
   ```sh
   mkdir -p /tmp/edujobs-v2 &&
   env -i PATH="$PATH" N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID=<id> N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_NAME="<name>" N8N_OPENAI_CREDENTIAL_ID=<id> N8N_OPENAI_CREDENTIAL_NAME="<name>" node n8n/build-workflow.mjs /tmp/edujobs-v2/workflow-a.json &&
   env -i PATH="$PATH" N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID=<id> N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_NAME="<name>" N8N_TELEGRAM_CREDENTIAL_ID=<id> N8N_TELEGRAM_CREDENTIAL_NAME="<name>" node n8n/build-workflow-b.mjs /tmp/edujobs-v2/workflow-b.json &&
   ssh root@<server-ip> 'mkdir -p /opt/n8n-project/vers2/workflows' &&
   scp /tmp/edujobs-v2/workflow-a.json /tmp/edujobs-v2/workflow-a-intake-trigger.json /tmp/edujobs-v2/workflow-b.json root@<server-ip>:/opt/n8n-project/vers2/workflows/
   ```
   На сервере:
   ```sh
   project=$(docker compose exec -T postgres psql -U n8n -d n8n -At -c "select id from project where type = 'personal'")
   for f in workflow-a.json workflow-a-intake-trigger.json workflow-b.json; do
     docker compose cp "vers2/workflows/$f" "n8n:/tmp/$f" &&
     docker compose exec -T n8n n8n import:workflow --input="/tmp/$f" --projectId="$project" &&
     docker compose exec -T -u root n8n rm -f "/tmp/$f" || break
   done
   ```
8. Сверка: у трёх новых workflow `active = f` и пустой `activeVersionId`, у остальных — то же, что в `vers2-workflows-before.txt`:
   ```sh
   docker compose exec -T postgres psql -U n8n -d n8n -At -c 'select id, name, active, "activeVersionId", "updatedAt" from workflow_entity order by id' > vers2-workflows-after.txt
   diff vers2-workflows-before.txt vers2-workflows-after.txt
   ```
   В `diff` должны быть только три добавленные строки.

### 3. Запуск в работу (выполняет пользователь)

1. **Credentials** в n8n. Переиспользуются существующие `Google Service Account account` (новая таблица открыта на редактирование для его email) и `Telegram account` — боевой бот канала `@edujobs`, ID `<production-bot-id>`; новые нужны только для OpenAI (`EduJobs v2 · OpenAI`, доступ к `gpt-6-luna`). Бот — администратор тестового и боевого каналов; его ID — в `WORKFLOW_B_TELEGRAM_EXPECTED_BOT_ID`. Workflow B обращается к Google через узлы HTTP Request, поэтому в `Google Service Account account` должен быть включён переключатель **Set up for use in HTTP Request node** со scope `https://www.googleapis.com/auth/spreadsheets`; без него запросы уходят без токена и Google отвечает 403 «Method doesn't allow unregistered callers». На узлы Google Sheets старых workflow этот переключатель не влияет.
2. **Таблица.** В строке 1 вкладки заявок — заголовки формы ровно `Timestamp`, `Short Description`, `Project Website Link`, `Original Link`, `Contact Info`, а за ними производные столбцы Workflow A ([LOCAL_SANDBOX, раздел 5](LOCAL_SANDBOX.md#5-prepare-the-non-production-sheet)). Вкладки старого workflow (`Parced`, `Review` и их столбцы) не должны совпадать с этой вкладкой и с вкладками Workflow B (`Review Queue`, `Archive`, `Control`, `Publication Batches`, `Publication Batch Items`, `_Workflow B Claim`).
3. **Переменные.** В `/opt/n8n-project/.env` вписать `GOOGLE_SHEETS_DOCUMENT_ID` и `GOOGLE_SHEETS_SHEET_NAME`, затем перезапустить n8n: `docker compose up -d --no-deps n8n`.
4. **Bootstrap Workflow B** — один раз для новой таблицы. Он создаёт вкладки и столбцы B и ничего не публикует:
   ```sh
   docker compose run --rm --no-deps -e WORKFLOW_B_MODE=setup n8n execute --id=edujobs-workflow-b
   ```
   Ожидается `SETUP_COMPLETE`. Одноразовый контейнер занимает ещё около 300 МБ памяти, пока работает.
5. **Публикация в n8n — строго в таком порядке:** сначала опубликовать (Publish/Activate) `EduJobs v2 · Vacancy Intake`, затем активировать `EduJobs v2 · Intake Trigger`. n8n не даст активировать триггер раньше: вызываемый workflow должен быть опубликован, а при вызове из активного workflow исполняется его опубликованная версия. `Telegram Publisher` оставить неактивным.
6. **Форма.** Перевести Google Form на новую таблицу. Строки, которые уже были в таблице на момент активации триггера, автоматически не обрабатываются (раздел 4).

### 4. Обычная работа

- **Новая заявка.** Форма добавляет строку, за следующие 5 минут Intake Trigger находит её номер и вызывает Vacancy Intake. Результат записывается в ту же строку.
- **Нельзя** удалять, вставлять или сортировать строки во вкладке заявок: Intake Trigger распознаёт новые строки по их количеству.
- **Ошибка Intake Trigger** (выполнение красное в n8n) перечисляет строки, которые нужно обработать вручную: `unlocated` — строку не удалось однозначно найти, `failed_calls` — вызов Vacancy Intake упал. Остальные строки этого опроса обработаны.
- **Ручная обработка строки** (старые строки, повтор, сбой) — одноразовым контейнером, запускается исполняемая версия из базы:
  ```sh
  docker compose run --rm --no-deps -e WORKFLOW_A_TEST_ROW_NUMBER=<номер строки> n8n execute --id=edujobs-workflow-a
  ```
  Одна команда — одна строка; следующую запускайте после завершения предыдущей.
- **Публикация:** проверьте строки, поставьте `PUBLISH` и `publication_order`, включите флажок `Control!B2`, затем один раз нажмите **Execute workflow** у `EduJobs v2 · Telegram Publisher` в интерфейсе n8n. Итоги и восстановление после сбоя описаны в [runbook Workflow B](WORKFLOW_B_RUNBOOK.md).

### 5. Переключение на боевой канал

1. Убедиться, что незавершённой пачки нет (в `Publication Batches` нет `CREATED`, `FAILED` или `PUBLISHING`), а бот — администратор боевого канала.
2. В `/opt/n8n-project/.env` заменить `WORKFLOW_B_TELEGRAM_CHAT_ID` на числовой ID боевого канала (`-100…`). Рекомендуется также сменить `WORKFLOW_B_CONFIG_VERSION`, чтобы пачки показывали новую конфигурацию.
3. `docker compose up -d --no-deps n8n`; проверить: `docker compose exec -T n8n sh -c 'echo $WORKFLOW_B_TELEGRAM_CHAT_ID'`.

### 6. Обновление

- **Код worker:** повторить шаги 2.2 (только `git archive …`) и `docker compose build content-worker && docker compose up -d content-worker`.
- **Workflow:** повторить шаги 2.7–2.8. Импорт снимает публикацию и активацию с импортируемых workflow. Затем снова выполнить шаг 3.5 по порядку: опубликовать Vacancy Intake, активировать Intake Trigger. Реимпортированный Intake Trigger начинает отсчёт строк заново: строки, добавленные до его новой активации, найдите по пустому `processing_status` и обработайте вручную (раздел 4).
- **Переменные:** правка `.env` и `docker compose up -d --no-deps n8n`. После смены моделей или лимитов поменяйте и `CONFIG_VERSION`.

### 7. Откат

1. Деактивировать `EduJobs v2 · Intake Trigger` и снять публикацию с `EduJobs v2 · Vacancy Intake`; при необходимости удалить три workflow в интерфейсе.
2. Убрать worker и переменные:
   ```sh
   mv docker-compose.override.yml vers2/docker-compose.override.yml.disabled
   cp .env.pre-vers2-<метка> .env
   docker compose up -d --no-deps --remove-orphans n8n
   ```
3. Проверить, что старый активный workflow снова активен: `docker compose logs --tail 30 n8n`.

Аварийная деактивация всех workflow из серверного RUNBOOK снимает публикацию и с Vacancy Intake: после неё повторите шаг 3.5.

### 8. Наблюдение

- Память: `free -h` и `docker stats --no-stream`. У сервера 2 ГБ RAM; worker ограничен 200 МБ, browserless обрабатывает одну страницу за раз.
- Успешные выполнения Vacancy Intake сохраняются (действуют `EXECUTIONS_DATA_PRUNE`, `MAX_AGE=168`, `PRUNE_MAX_COUNT=1000`). Если `execution_data` растёт к порогу тревоги из серверного RUNBOOK, отключите в настройках Vacancy Intake сохранение успешных production-выполнений. Эта настройка сбрасывается при реимпорте.
