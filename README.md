# pi-frugal

A [Pi](https://github.com/earendil-works/pi) extension that cuts model cost without changing what the agent can do.

| Rule | What it does |
|---|---|
| Long-wait guard | Blocks long `sleep`s, sleep-poll loops and unbounded test or gate runs. It tells the agent to background the job and check later instead of holding the turn. |
| Output spill | Writes text tool output over 10,000 characters to a file and gives the model a 1,600-character stub with the path |
| Stable prompt | Flags extensions that rewrite the system prompt every turn, which breaks the prompt cache |
| Keep-warm | While idle, pings every few minutes so the prompt cache stays warm, then stops |

## Install

```sh
pi install /path/to/pi-frugal
```

## Evidence

Each rule was tried offline on a fixed set of real sessions, then live. `results.jsonl` has every attempt, kept or not. The `eval-*.json` files are the offline replays.

To replay on your own sessions:

```sh
node --experimental-strip-types proof/eval.ts
```

It reads `~/.pi/agent/sessions` (set `PI_SESSIONS_DIR` to change it).

`proposals/` holds suggested diffs for other extensions that break the prompt cache. They are not applied.

MIT licensed.
