# B2-SMALL-DECIDED: lead verification still required

Candidate: uncommitted changes on `b2/u-small-decided`, base
`56d9ce858ae0c1a36920e5ec9fcd7417e65ede2b`. No build, real PTY, vendor CLI,
live installation or N1 operation was run by this lane.

After the lead assembles and builds this exact candidate, run these tests on a
PTY-capable host under the shared heavy lock (no concurrent build):

```sh
flock /tmp/claude-1000/deckent-heavy.lock env VITEST_MAX_FORKS=2 npx vitest run --configLoader runner --fsModuleCachePath /tmp/deckent-b2-small-vitest-cache tests/contracts/surfaces/terminal-fullscreen-pty.test.ts tests/contracts/surfaces/terminal-arrow-pickers-pty.test.ts tests/contracts/surfaces/monitor-pty-process.test.ts
```

Record the assembled revision, terminal, platform and retained output. These
tests are not a substitute for checking the real clipboard:

- With `terminal.theme=auto` and no reported background, the resolved
  `neutral-ansi` palette has an empty accent but tier `ansi16`. Verify inverse
  caret, dim placeholder and monitor row selection. With `NO_COLOR`, verify
  the original marker caret and plain placeholder, with no styling escapes.
- In a real terminal, then inside tmux with clipboard passthrough configured,
  drag over synthetic text and paste elsewhere. Check exact Unicode text and
  that the notice says a request was sent. No credential content is needed.
- Select synthetic text across scrollback that exceeds the registered
  65,536-byte clipboard bound. Verify the explicit EN/TR refusal, no success
  notice and no truncated clipboard request. Check the exact bound as well.
- Check opening work counts against a disposable fixture containing verified
  running/created/paused, unknown/present-unverified/denied and released/ended
  workers. Unknowns must be separate from active counts in terminal and CLI;
  an unknown-only snapshot must still show its count, in EN and TR.

Items 1 and 5 are STOPPED as required by the card: Cursor's CLI login filename
was not established by the consulted current official docs; no existing
cross-process lock supports shared readers. Neither item is implemented here.
The lane report records the sources, existing consumers and lock options.

Independent batch review and owner acceptance remain with the lead/owner.
