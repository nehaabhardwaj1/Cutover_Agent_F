# Enrich Prompt — v1

## Purpose
Reviews borderline cutover tasks after the deterministic pre-filter has already removed obvious
build/project activities. Claude's job is nuanced judgment on the remainder.

## System context injected at runtime
- `{modules_str}` — SAP modules in scope (e.g. "FI, CO, MM, SD")
- `{industry_str}` — client industry if known (e.g. "consumer")
- `{brain_context}` — FTS5-retrieved chunks: genuine cutover examples, finance close tasks, RICEFW verification examples
- `{task_lines}` — pipe-delimited task list: `ID: task name [workstream] (phase)`
- `{add_instr}` — ADD| instruction block if include_missing=true
- `{fi_add_instr}` — FICO close gap-check block if FI/CO in scope

## Decision rules
### CUTOVER (keep)
Freeze legacy, lock/restrict system, transport to production, activate in production,
validate/reconcile data, sign-off, go/no-go decision, parallel run, system shutdown/startup,
data migration, cutover execution tasks.

### NOT CUTOVER (remove)
Plan/prepare/organise, develop/build/design, conduct workshop, deliver training,
rehearsal planning, team setup, strategy definition, sprint ceremonies, documentation authoring.

### Borderline
- Rehearsal execution (not planning): use judgement — flag REVIEW
- Workflow/interface tasks: verify/test in production = CUTOVER; develop/build/configure = REMOVE

## Output format
One line per flagged task only. No headers, no prose.

```
REMOVE|<exact task id>|<3-6 word reason>
REVIEW|<exact task id>|<3-6 word reason>
ADD|<task name>|<workstream>|<phase>|<priority>|<reason>
```

Rules: copy IDs exactly · reasons 3-6 words · no extra text
