---
name: pi-stick
description: Use the pistick CLI to run actions in isolated workspaces, inspect results, or find project setup instructions.
---

# pi-stick

Run `pistick` on the host:

1. List workspaces with `pistick projects`, then available actions with `pistick actions --project PROJECT`.
2. Start a task with `pistick run PROJECT ACTION --ref REF "Task prompt"`. Omit `--ref REF` to use the default checkout. Keep the printed run ID.
3. Watch progress with `pistick follow RUN_ID`; inspect the run with `pistick show RUN_ID` or its changes with `pistick diff RUN_ID`.

For other commands, use `pistick --help`. To create or configure a workspace, read [project-create](project-create/SKILL.md).
