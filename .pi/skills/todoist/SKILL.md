---
name: todoist
description: Manage Todoist tasks and projects via the Todoist API v1. Use when creating, listing, updating, completing, or deleting tasks and projects. Supports labels, priorities, due dates, and sections.
---

# Todoist

Manage tasks and projects in Todoist via CLI scripts.

## Setup

The API key is stored in 1Password. Scripts fetch it automatically via:
```
op read "op://Agents Service Accounts/Todoist API Credential/credential"
```

Ensure `op` (1Password CLI) is authenticated before use.

## Scripts

All scripts are in the skill directory. Use relative paths from this file's location.

### Tasks

**List tasks** (optionally filter by project or label):
```bash
./scripts/todoist.sh tasks list
./scripts/todoist.sh tasks list --project "Inbox"
./scripts/todoist.sh tasks list --label "urgent"
./scripts/todoist.sh tasks list --filter "today | overdue"
```

**Create a task:**
```bash
./scripts/todoist.sh tasks create "Task content" \
  --description "Optional description" \
  --project "Inbox" \
  --priority 4 \
  --due "tomorrow" \
  --labels "customer-support,follow-up"
```

Priority: 1 (normal) to 4 (urgent). Due dates accept natural language ("tomorrow", "next Monday", "2026-03-01").

**Update a task:**
```bash
./scripts/todoist.sh tasks update <task_id> \
  --content "New content" \
  --priority 3 \
  --due "next week"
```

**Complete a task:**
```bash
./scripts/todoist.sh tasks complete <task_id>
```

**Delete a task:**
```bash
./scripts/todoist.sh tasks delete <task_id>
```

**Get task details:**
```bash
./scripts/todoist.sh tasks get <task_id>
```

### Projects

**List projects:**
```bash
./scripts/todoist.sh projects list
```

**Create a project:**
```bash
./scripts/todoist.sh projects create "Project name" --color "blue"
```

**Get project details:**
```bash
./scripts/todoist.sh projects get <project_id>
```

### Sections

**List sections in a project:**
```bash
./scripts/todoist.sh sections list --project-id <project_id>
```

**Create a section:**
```bash
./scripts/todoist.sh sections create "Section name" --project-id <project_id>
```

### Comments

**List comments on a task:**
```bash
./scripts/todoist.sh comments list --task-id <task_id>
```

**Add a comment:**
```bash
./scripts/todoist.sh comments create --task-id <task_id> "Comment text"
```

## Tips

- Use `--filter` with Todoist filter syntax for complex queries: `"today & @customer-support"`, `"overdue"`, `"p1"`, `"assigned to: me"`
- Labels are comma-separated, no spaces
- Task IDs are returned on creation — save them for updates
- Use projects to organize by area (e.g., "Customer Support") and labels for cross-cutting tags
