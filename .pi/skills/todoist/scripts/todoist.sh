#!/usr/bin/env bash
set -euo pipefail

# ── Config ────────────────────────────────────────
API_BASE="https://api.todoist.com/api/v1"
API_KEY=$(op read "op://Agents Service Accounts/Todoist API Credential/credential" 2>/dev/null) || {
  echo "ERROR: Failed to read Todoist API key from 1Password. Ensure 'op' is authenticated." >&2
  exit 1
}

# ── Helpers ───────────────────────────────────────

api() {
  local method="$1" endpoint="$2"
  shift 2
  curl -s -X "$method" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    "$@" \
    "${API_BASE}${endpoint}"
}

json_pp() {
  python3 -m json.tool 2>/dev/null || cat
}

die() { echo "ERROR: $*" >&2; exit 1; }

# ── Resolve project name → ID ────────────────────

resolve_project_id() {
  local name="$1"
  # If it looks like an ID already, return as-is
  if [[ "$name" =~ ^[0-9a-zA-Z]{16,}$ ]]; then
    echo "$name"
    return
  fi
  local id
  local lower_name
  lower_name=$(echo "$name" | tr '[:upper:]' '[:lower:]')
  id=$(api GET /projects | python3 -c "
import sys, json
target = sys.argv[1].lower()
data = json.load(sys.stdin)
results = data.get('results', data) if isinstance(data, dict) else data
for p in results:
    if p['name'].lower() == target:
        print(p['id'])
        sys.exit(0)
print('')
" "$lower_name" 2>/dev/null)
  if [[ -z "$id" ]]; then
    die "Project not found: $name"
  fi
  echo "$id"
}

# ── Tasks ─────────────────────────────────────────

tasks_list() {
  local project="" label="" filter=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project)  project="$2"; shift 2 ;;
      --label)    label="$2"; shift 2 ;;
      --filter)   filter="$2"; shift 2 ;;
      *) die "Unknown option: $1" ;;
    esac
  done

  local params=""
  if [[ -n "$project" ]]; then
    local pid
    pid=$(resolve_project_id "$project")
    params="project_id=$pid"
  fi
  if [[ -n "$label" ]]; then
    [[ -n "$params" ]] && params+="&"
    params+="label=$label"
  fi
  if [[ -n "$filter" ]]; then
    local encoded
    encoded=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$filter'))")
    [[ -n "$params" ]] && params+="&"
    params+="filter=$encoded"
  fi

  local url="/tasks"
  [[ -n "$params" ]] && url+="?${params}"

  api GET "$url" | python3 -c "
import sys, json
data = json.load(sys.stdin)
results = data.get('results', data) if isinstance(data, dict) else data
if not results:
    print('No tasks found.')
    sys.exit(0)
for t in results:
    pri = {1:'  ',2:'P3',3:'P2',4:'P1'}.get(t.get('priority',1),'  ')
    due = ''
    if t.get('due'):
        due = t['due'].get('date','')
    labels = ','.join(t.get('labels',[])) or ''
    status = '✓' if t.get('checked') else '○'
    print(f\"{status} [{pri}] {t['id'][:12]:12s}  {due:12s}  {labels:20s}  {t['content']}\")
"
}

tasks_create() {
  local content="" description="" project="" priority="" due="" labels=""
  content="$1"; shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --description) description="$2"; shift 2 ;;
      --project)     project="$2"; shift 2 ;;
      --priority)    priority="$2"; shift 2 ;;
      --due)         due="$2"; shift 2 ;;
      --labels)      labels="$2"; shift 2 ;;
      *) die "Unknown option: $1" ;;
    esac
  done

  local json
  json=$(python3 -c "
import json
data = {'content': '''$content'''}
desc = '''$description'''
if desc: data['description'] = desc
pri = '$priority'
if pri: data['priority'] = int(pri)
due = '''$due'''
if due: data['due_string'] = due
labels = '$labels'
if labels: data['labels'] = labels.split(',')
print(json.dumps(data))
")

  if [[ -n "$project" ]]; then
    local pid
    pid=$(resolve_project_id "$project")
    json=$(echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); d['project_id']='$pid'; print(json.dumps(d))")
  fi

  api POST /tasks -d "$json" | json_pp
}

tasks_update() {
  local task_id="$1"; shift
  local json="{}"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --content)  json=$(echo "$json" | python3 -c "import sys,json;d=json.load(sys.stdin);d['content']='''$2''';print(json.dumps(d))"); shift 2 ;;
      --priority) json=$(echo "$json" | python3 -c "import sys,json;d=json.load(sys.stdin);d['priority']=int('$2');print(json.dumps(d))"); shift 2 ;;
      --due)      json=$(echo "$json" | python3 -c "import sys,json;d=json.load(sys.stdin);d['due_string']='''$2''';print(json.dumps(d))"); shift 2 ;;
      --labels)   json=$(echo "$json" | python3 -c "import sys,json;d=json.load(sys.stdin);d['labels']='$2'.split(',');print(json.dumps(d))"); shift 2 ;;
      --description) json=$(echo "$json" | python3 -c "import sys,json;d=json.load(sys.stdin);d['description']='''$2''';print(json.dumps(d))"); shift 2 ;;
      *) die "Unknown option: $1" ;;
    esac
  done

  api POST "/tasks/$task_id" -d "$json" | json_pp
}

tasks_complete() {
  local task_id="$1"
  api POST "/tasks/$task_id/close" | json_pp
  echo "Task $task_id completed."
}

tasks_delete() {
  local task_id="$1"
  api DELETE "/tasks/$task_id"
  echo "Task $task_id deleted."
}

tasks_get() {
  local task_id="$1"
  api GET "/tasks/$task_id" | json_pp
}

# ── Projects ──────────────────────────────────────

projects_list() {
  api GET /projects | python3 -c "
import sys, json
data = json.load(sys.stdin)
results = data.get('results', data) if isinstance(data, dict) else data
for p in results:
    fav = '★' if p.get('is_favorite') else ' '
    print(f\"{fav} {p['id'][:16]:16s}  {p['name']}\")
"
}

projects_create() {
  local name="$1"; shift
  local color=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --color) color="$2"; shift 2 ;;
      *) die "Unknown option: $1" ;;
    esac
  done
  local json="{\"name\": \"$name\"}"
  if [[ -n "$color" ]]; then
    json=$(echo "$json" | python3 -c "import sys,json;d=json.load(sys.stdin);d['color']='$color';print(json.dumps(d))")
  fi
  api POST /projects -d "$json" | json_pp
}

projects_get() {
  local project_id="$1"
  api GET "/projects/$project_id" | json_pp
}

# ── Sections ──────────────────────────────────────

sections_list() {
  local project_id=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project-id) project_id="$2"; shift 2 ;;
      *) die "Unknown option: $1" ;;
    esac
  done
  [[ -z "$project_id" ]] && die "Missing --project-id"
  api GET "/sections?project_id=$project_id" | json_pp
}

sections_create() {
  local name="$1"; shift
  local project_id=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project-id) project_id="$2"; shift 2 ;;
      *) die "Unknown option: $1" ;;
    esac
  done
  [[ -z "$project_id" ]] && die "Missing --project-id"
  api POST /sections -d "{\"name\": \"$name\", \"project_id\": \"$project_id\"}" | json_pp
}

# ── Comments ──────────────────────────────────────

comments_list() {
  local task_id=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --task-id) task_id="$2"; shift 2 ;;
      *) die "Unknown option: $1" ;;
    esac
  done
  [[ -z "$task_id" ]] && die "Missing --task-id"
  api GET "/comments?task_id=$task_id" | json_pp
}

comments_create() {
  local task_id="" content=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --task-id) task_id="$2"; shift 2 ;;
      *) content="$1"; shift ;;
    esac
  done
  [[ -z "$task_id" ]] && die "Missing --task-id"
  [[ -z "$content" ]] && die "Missing comment content"
  api POST /comments -d "{\"task_id\": \"$task_id\", \"content\": \"$content\"}" | json_pp
}

# ── Router ────────────────────────────────────────

resource="${1:-help}"; shift || true
action="${1:-list}"; shift || true

case "$resource" in
  tasks)
    case "$action" in
      list)     tasks_list "$@" ;;
      create)   tasks_create "$@" ;;
      update)   tasks_update "$@" ;;
      complete) tasks_complete "$@" ;;
      delete)   tasks_delete "$@" ;;
      get)      tasks_get "$@" ;;
      *) die "Unknown tasks action: $action" ;;
    esac
    ;;
  projects)
    case "$action" in
      list)   projects_list "$@" ;;
      create) projects_create "$@" ;;
      get)    projects_get "$@" ;;
      *) die "Unknown projects action: $action" ;;
    esac
    ;;
  sections)
    case "$action" in
      list)   sections_list "$@" ;;
      create) sections_create "$@" ;;
      *) die "Unknown sections action: $action" ;;
    esac
    ;;
  comments)
    case "$action" in
      list)   comments_list "$@" ;;
      create) comments_create "$@" ;;
      *) die "Unknown comments action: $action" ;;
    esac
    ;;
  help|--help|-h)
    echo "Usage: todoist.sh <resource> <action> [options]"
    echo ""
    echo "Resources: tasks, projects, sections, comments"
    echo "Run with a resource for action-specific help."
    ;;
  *) die "Unknown resource: $resource" ;;
esac
