# Resource observation and quality

Owner-admitted CARD: KAYNAK-KALITE-UYGULAMA, 2026-10-12; landed in alpha.31.

The dispatch owner starts observation only after its durable launch grant. A service collector
caps concurrent reads, schedules one cancellable read per worker at a configured interval and
queues asynchronous writes without awaiting them on the execution path. Read deadlines also
bound non-cooperative readers without releasing their physical concurrency slot before settlement.
Stopping observation aborts its read/write and drops its queued samples; trace-lock waiting obeys
the same cancellation. Observation timers are unreferenced and cannot keep a stopped process alive. It cannot launch,
cancel, settle, accept or change any work. Docker reads the pinned local Engine socket, validates
the request label and full container id/start time before and after stats, and never attaches
another incarnation. The optional cgroup-v2 peak requires that the local PID's cgroup contains
the full container id; Docker Desktop/other namespaces with no proven match keep it unknown.
Older Docker Engine one-shot responses may omit `id` (Moby #51302). Samples still require
the full-id stats request bracketed by matching id/start/label inspections; any supplied
stats id must agree. Missing response id does not imply unsupported sampling. Engine access
denial/unsupported responses remain explicit gaps, and unreadable optional cgroup peak never
turns measured Engine CPU/RAM into zero or invents a peak. Author regression and retained
hosted diagnosis: external `proof/HOSTED-KAYNAK-2026-10-12/`; fresh hosted acceptance is open.

`resourceObservation` is registered configuration: interval, timeout, concurrency, body/queue,
store byte/entry/retention and stale bounds, segment byte/entry/age bounds and sync interval. Defaults are explicitly provisional until an
OFF/ON pilot measures overhead and coverage. Observed raw RAM includes cache; sampled peak and
kernel peak are different fields. First/reset/missing CPU intervals remain unknown.

The bounded private append-only trace segments live under the existing `brain` product resource,
separately from the Run SQLite ledger and `acceptance_metrics`. Its path is registry configuration,
not a host home path. Shared locking serializes writers; retention and size eviction carry a
trim watermark in a small atomic checkpoint (the most recently trimmed Attempt, as in v1).
Segments use 0600, no-follow regular-file custody and monotonically ordered names. A new segment
opens at its configured byte/entry/age bound; global byte/entry/retention bounds delete the oldest
whole segments with individual unlink calls. The checkpoint and headers count toward the byte
budget. Retention cleanup occurs on append. Legacy v1 JSON stays readable and immutable until
whole-file eviction; no bulk migration rewrite occurs. Incomplete/malformed sample lines become
explicit unknown `invalid` gaps for affected readable Attempts; their counters are never consumed.
New segments and rotation boundaries sync; subsequent writes sync at the configured interval
(default 15 s), with no timer or stop-time flush. Complete unsynced records may be lost after a
power failure; telemetry always remains partial and is never an acceptance ledger. The existing
shared lock still syncs its small owner record per append. Trace writes are proportional to the
new sample, plus bounded segment/checkpoint overhead at rotation/eviction; reading and replay
checking still scan retained bounded storage, once per worker page for all of its Attempts (`readMany`;
2026-10-17 the per-Attempt re-scan made one N1 page set take 5.8 s). No OFF/ON pilot improvement is claimed.
Replay deduplicates samples; unknown/dropped writes never imply complete coverage.
A failed write is buffered as a gap for the next successful write. If the process or disk prevents
that marker, the reader still reports partial/unavailable/stale, never full recording.

The current scoped worker inspect contract carries `resources` to CLI, SDK, MCP and monitor.
Per-Attempt `read-output` authority precedes disclosure of trace values, including finished workers;
the page's single trace read is never attached to a denied worker, which carries no resource values. Text carries state, sample age, null values and gap reason;
JSON has the same typed values. Narrow monitor rows retain full values in selected-worker detail.
Observation is unrelated to acceptance or worker health.

Run inspect now carries one `costReport` (v1), shared by local SDK, runtime, MCP and `deckent report
--scope … --run …`. The canonical snapshot revision and full Attempt identity bind profile, model
pin, effort and WorkClass acceptance. Docker wall time and sampled CPU/peak remain separate from
digest-checked `measured-tariff` API money; worker-reported money is never a measured API charge.
Sealed native duration is observed subscription usage, not a plan limit. Missing call counts,
local-model attribution, human intervention, quality rework/rollback and follow-up remain null/unknown;
generation alone does not prove quality rework. The monitor derives the same contract from its
scoped snapshot. Denied evidence is absent from per-worker values and subtotals; unit cost without
an accepted denominator, or with withheld/missing CPU, is null. Replay/conflicting rows cannot
double-count consumption. This view cannot write acceptance or settlement.

Task evaluation returns its immutable receipt projection and the existing output-authorized
result/delivery view; it never adds read-time `pool` or `costReport` observations. Under unchanged
output authority and result evidence, the same evaluation command replays exactly, including its
original Run revision. Inspect/evaluate equality excludes only `pool` and `costReport`; both remain
inspection observations. `costReport.observedAtMs` is the inspection sampling instant, so separate
inspections may differ. Run inspect and per-Attempt `read-output` authority still apply before
any cost/resource aggregation. Supplemental cost-metric corruption produces `run-cost-unavailable` and
withholds those metrics without hiding the canonical Run or its acceptance producer receipt.

The pure `recommendCostProfile` engine compares registered profile identities per WorkClass and
explicit cost axis. A pair binds exact Attempts, workload, environment, criterion/policy and
held-out split digests. One acceptance, criterion, safety, score, intervention, rework or rollback
loss vetoes the candidate before sample sufficiency. Unknown quality/model/follow-up/cost,
unmatched or contradictory evidence and repeated Attempts cannot produce a proposal. Config owns
minimum pairs, confidence, upper loss-risk bound and evidence/candidate caps. With zero observed
losses the one-sided binomial upper bound assumes representative independent pairs; candidate
search adjusts confidence for the number compared. This is no future-quality guarantee.

`recommendRunWorkCosts` attaches localized reasons, counts and risk to inspect/report/monitor
without changing model, effort, limits, parallelism or acceptance. Current composition supplies
registry and provisional policy, but has no authoritative held-out/follow-up comparison producer:
`readComparisons` is an explicit evidence port, not synthesized from accepted counts. Real
reports therefore retain the profile and say insufficient evidence until that producer and pilot
exist. Recommendations accept only the report's permitted exact Attempts, and truncated candidate
sets stay explicit. No raw sample or comparative evidence is written to acceptance_metrics.
Author unit/contract evidence, independent review, real binary/platform evidence and owner
acceptance are distinct. No live/N1 or paid provider pilot is authorized in this author lane.
