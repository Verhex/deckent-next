# Diagnosing a hard defect

Read this when a defect resists a first look: an intermittent failure, a regression between two known states, a
wrong result nobody can explain, a performance drop. It complements `superpowers:systematic-debugging` with a
sharper entry gate. Adapted from mattpocock/skills `diagnosing-bugs` (MIT, see
[LICENSE-mattpocock.md](LICENSE-mattpocock.md)).

## Redact first

Commands, outputs and captured artifacts you show carry no secret: write `<REDACTED>`, keep credentials in the
environment, quote only the lines that carry the signal.

## 1. A signal that goes red on this defect

The whole method rests on one command that turns **red** on this exact defect and green once it is fixed.
Build it before reading code for a theory. In rough order: a failing test at the seam that reaches the defect;
a CLI/HTTP/MCP call with a fixture diffed against a known-good result; replay of a retained trace, Run record or
audit entry; a minimal harness around the code path; a stress loop for flakes (raise the reproduction rate until
it is debuggable); `git bisect run` between two known states; a differential run of old versus new.

Done when you can name **one command you have already run** (show it and its redacted output) that drives the
real code path, asserts the reported symptom, gives the same verdict each run (or a pinned high rate for
flakes), runs in seconds, and runs unattended. If no such signal can be built, say so, list what you tried and
ask for access, a captured artifact or permission for temporary instrumentation.

Two perspectives: in Deckent's own development the signal is usually a test or CLI call. In the target product a
customer's ERP/CRM process has no test suite; the red signal is a read-only query or a durable evidence record
showing the wrong business state. Test code is the git adapter's evidence, not the general acceptance model.

## 2. Reproduce and minimise

Confirm the red is the failure that was reported, not a neighbour. Then cut inputs, callers, config and steps one
at a time, re-running after each cut, until every remaining element is load-bearing.

## 3. Hypotheses

Write 3–5 ranked, falsifiable hypotheses before testing any: "if X is the cause, changing Y makes it disappear".
Show the list to the owner or lead when they may know which one is already ruled out; do not block on it.

## 4. Instrument

Each probe tests one prediction; change one variable at a time. Tag temporary logs with a unique prefix such as
`[DEBUG-a4f2]` so cleanup is one grep. For performance, measure a baseline first, then bisect.

## 5. Fix and regression proof

Write the regression test before the fix, at a seam that exercises the real defect pattern. If only a too-shallow
seam exists, that is itself a finding for the architecture, not a reason for a test that gives false confidence.
Watch it fail, fix the root cause, watch it pass, then re-run the original un-minimised signal.

## 6. Cleanup

The original signal is green, the regression proof passes (or the missing seam is recorded), every `[DEBUG-`
line is gone, throwaway harnesses are removed, and the confirmed hypothesis is stated in the commit message.
