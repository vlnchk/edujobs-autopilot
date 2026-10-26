#!/bin/sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
project_name="edujobs-m7-verify-$$"
verification_dir=$(mktemp -d "${TMPDIR:-/tmp}/edujobs-m7-import.XXXXXX")
generated_workflow="$root_dir/n8n/.workflow-a-verify-$$.json"
generated_intake_trigger="$root_dir/n8n/.workflow-a-verify-$$-intake-trigger.json"
N8N_HOST_PORT=0
export N8N_HOST_PORT

compose() {
  docker compose \
    --project-name "$project_name" \
    --env-file "$root_dir/.env.example" \
    --file "$root_dir/docker-compose.yml" \
    "$@"
}

cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -f "$generated_workflow" "$generated_intake_trigger"
  rm -f "$verification_dir/imported-workflow.json" "$verification_dir/imported-intake-trigger.json"
  rmdir "$verification_dir" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID=sandbox-google-credential-id \
N8N_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_NAME='Sandbox Google Service Account' \
N8N_OPENAI_CREDENTIAL_ID=sandbox-openai-credential-id \
N8N_OPENAI_CREDENTIAL_NAME='Sandbox OpenAI API' \
  node "$root_dir/n8n/build-workflow.mjs" "$generated_workflow"

docker info >/dev/null
compose config --quiet
compose build content-worker
compose pull --quiet n8n browserless
compose up --detach --wait --wait-timeout 240

running=$(compose ps --services --status running | sort | tr '\n' ' ')
test "$running" = "browserless content-worker n8n "

compose exec -T n8n n8n --version | grep -Fx "2.35.7"
compose exec -T n8n node -e "fetch('http://content-worker:8000/health').then(async r=>{const body=await r.text();if(!r.ok||body!=='{\"status\":\"ok\"}')process.exit(1);console.log(body)}).catch(error=>{console.error(error);process.exit(1)})"
compose exec -T content-worker python -c "import urllib.request; assert urllib.request.urlopen('http://browserless:3000/active', timeout=3).status == 204"
compose exec -T n8n node /files/n8n/verify-runtime.mjs "/files/n8n/$(basename "$generated_workflow")"

compose stop n8n
compose run --rm --no-deps n8n import:workflow --input="/files/n8n/$(basename "$generated_workflow")"
compose run --rm --no-deps n8n import:workflow --input="/files/n8n/$(basename "$generated_intake_trigger")"
chmod 777 "$verification_dir"
compose run --rm --no-deps -v "$verification_dir:/verification" n8n export:workflow --id=edujobs-workflow-a --output=/verification/imported-workflow.json
compose run --rm --no-deps --entrypoint node -v "$verification_dir:/verification:ro" n8n /files/n8n/verify-runtime.mjs /verification/imported-workflow.json
compose run --rm --no-deps -v "$verification_dir:/verification" n8n export:workflow --id=edujobs-intake-trigger --output=/verification/imported-intake-trigger.json
compose run --rm --no-deps --entrypoint node -v "$verification_dir:/verification:ro" n8n -e "
const [w] = [].concat(JSON.parse(require('fs').readFileSync('/verification/imported-intake-trigger.json', 'utf8')));
const names = w.nodes.map((n) => n.name).join(',');
if (w.active !== false || w.name !== 'EduJobs v2 · Intake Trigger' || names !== 'Google Sheets Trigger,Read Application Rows,Locate Added Rows,Execute Vacancy Intake,Report Intake Result') process.exit(1);
console.log('Intake Trigger imported inactive: ' + names);
"

compose down --volumes --remove-orphans
test -z "$(compose ps --quiet)"
echo "M7 sandbox verification passed"
