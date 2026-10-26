# Proposed diffs for other extensions (not applied)

Why: pi-frugal rule 3 found that these handlers return a full `systemPrompt` from
`before_agent_start`. That forces an opaque prompt on every run. terraloop-mode also puts
live counters (`delegated=`, `inline=`, `overrideGrants=`) in the prompt, so the prompt text
changes after each tool call and the cache prefix breaks at the next run.

Fix: write a named entry in `event.systemPromptOptions.sections` instead, so Pi can append a
transcript delta. In terraloop-mode, keep only stable fields (phase, goal, gate, scope) in the
prompt. Move the counters into tool results or `terraloop_control status`.

- no-added-comments.diff: safe, 3 lines.
- terraloop-mode.diff: needs `describePhaseOnly` and a test. The installed clone at
  ~/.pi/agent/git/github.com/acoyfellow/terraloop-mode has uncommitted work from another session.
  Apply it in ~/cloudflare/terraloop-mode and bump the pinned commit in settings.json.
- fresh-session-handoff: returns a `message` once per session. No change needed.
- loops-yaml, terrarium: no `before_agent_start` prompt edits found. No change needed.
