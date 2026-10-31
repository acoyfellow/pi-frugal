import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeBashCommand } from "../src/core.ts";

const allowed: readonly [string, string][] = [
  ["grep that mentions a gate script", `grep -n "gate.sh" README.md`],
  ["chmod on a gate script", "chmod +x gate.sh scan/handcheck.sh"],
  ["ls on a gate script", "ls -l@ gate.sh; xattr gate.sh"],
  ["git add of a proof script", "git add proof/readback-real.sh experiments/x/score.py"],
  ["python heredoc that edits gate.sh", `python3 - <<'EOF'\np='gate.sh'; s=open(p).read()\nopen(p,'w').write(s)\nEOF`],
  ["sed that rewrites a gate script", `sed -i '' 's/a/b/' gate.sh`],
  ["prompt text that names npm test", `pi -p "Run 'npm test'. If it passes, reply DONE."`],
  ["python heredoc whose string names npm test", `python3 - <<'EOF'\nprint("Run 'npm test' then stop")\nEOF`],
  ["cat of a file in proof/", "cat proof/run.json | head"],
  ["grep for the word sleep", `grep -c "sleep 6" log.txt`],
  ["prompt text that contains sleep", `pi -p "run: sleep 6 && echo waited"`],
  ["heredoc with a for loop and the word sleep", `cat > t.ts <<'EOF'\nfor (const x of xs) {}\nconst label = "sleep 6";\nEOF`],
  ["a time limit named inside a message", `cmux send --surface s:1 'one bash call held the terminal for alarm 1500 seconds'`],
  ["a nohup bash -c that waits in the background", `nohup bash -c 'while pgrep -f ship.sh >/dev/null; do sleep 5; done; bash ship.sh' > log 2>&1 < /dev/null & disown`],
  ["background deploy with nohup", "nohup npx wrangler deploy > deploy.log 2>&1 &"],
];

const blocked: readonly [string, string][] = [
  ["running a gate script", "./gate.sh"],
  ["running a gate script with bash", "bash gate.sh"],
  ["running a proof script", "bash proof/gate.sh"],
  ["npm test as a command", "npm test 2>&1 | tail -30"],
  ["cd then npm test", "cd app && npm test"],
  ["a long sleep", "sleep 40; cat out.log"],
  ["a polling loop", "while true; do curl -s x; sleep 2; done"],
  ["a long sleep after a heredoc", `cat > a.txt <<'EOF'\nhi\nEOF\nsleep 40`],
  ["bash -c that sleeps", `bash -c "sleep 40"`],
  ["a polling loop inside bash -c", `perl -e 'alarm 100; exec @ARGV' bash -c 'until curl -s localhost:1; do sleep 2; done'`],
  ["a perl alarm over the limit", `perl -e 'alarm 1500; exec @ARGV' ./gate.sh`],
];

for (const [why, command] of allowed) {
  test(`allows: ${why}`, () => assert.equal(judgeBashCommand(command).blocked, false, command));
}

for (const [why, command] of blocked) {
  test(`still blocks: ${why}`, () => assert.equal(judgeBashCommand(command).blocked, true, command));
}
