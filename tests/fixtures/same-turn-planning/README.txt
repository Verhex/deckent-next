# Same-turn planning — K3a, first gate

Source: clean base `568e0527f6a273f258d04759e2999ecbd6c25bc4`, DESIGN Rev3
R3.1–R3.7 and design-only review 3253. Rev3 replaces the old literal START requirement.

Both `codex/positive` and `claude/positive` still require a **real challenge recording**
with the selected exact binary/version/model and registry-produced argv before K1/K2
may open. No file here is a real recording. A0 is unchanged. The old A0 normal-close
sub-evidence does not demonstrate the challenge protocol or a person card.

Each CLI has six fixture directories, each with its own manifest:

- `positive`: hand-built native stdout JSONL and a separate synthetic host custody trace.
- `group-1`: stale output, wrong challenge/pin/identities/correlation and old message id.
- `group-2`: same-call/finalize replay, different second proposal and additional tool.
- `group-3`: early/public leaks, stitching/framing/wrong-source and bounded chunking.
- `group-4`: abnormal/missing/conflicting close, limits/truncation and extra JSON/payload.
- `group-5`: settlement/release/redaction faults, crash intervals and unknown admission.

A negative bundle's `cases.jsonl` has one case per line: `wire` is the native event
sequence (replay each element as JSON + LF), `host` is separate fixture custody,
`mutations` states exact replacements, and `expected` is the future verifier oracle.
The manifest pins every file's SHA-256/bytes/lines and each changed JSON pointer and
replacement digest. Replay/chunking positives within negative groups are explicitly
labelled. All token values are public test data. These are verifier inputs, not a
second verifier or evidence that K1/K2 already enforce the expectations.

[Recording kit](RECORDING.txt) and [source-produced argv](argv.from-source.json).
The manifest integrity test checks provenance, bytes and the positive wire/envelope
contract; it does not certify the negative verdicts or installed product acceptance.

Green transition after K1/K2: replace the cancel-waiting outer fake send with a
real-protocol replay: correlated preparation delivery, one challenge-framed terminal
draft and normal CLI close/drain. Only then replace it.todo with it. Preparation
alone must never open the person card or satisfy the old refusal barrier. Preserve
one card, one claim/send and zero Run before the person's decision. The Brain
settings stay cap null / reasoning model-default; the request cap seen today is the
terminal's own inherited output cap (a positive number by schema), not a Brain
requirement, and the green phase must not require a separate brain-prepare call.
