# Resource observation and quality

Owner-admitted CARD: KAYNAK-KALITE-UYGULAMA, 2026-10-12; alpha.31 author candidate.

The dispatch owner starts observation only after its durable launch grant. A service collector
caps concurrent reads, schedules one cancellable read per worker at a configured interval and
queues asynchronous writes without awaiting them on the execution path. It cannot launch,
cancel, settle, accept or change any work. Docker reads the pinned local Engine socket, validates
the request label and full container id/start time before and after stats, and never attaches
another incarnation. The optional cgroup-v2 peak requires that the local PID's cgroup contains
the full container id; Docker Desktop/other namespaces with no proven match keep it unknown.

`resourceObservation` is registered configuration: interval, timeout, concurrency, body/queue,
store byte/entry/retention and stale bounds. Defaults are explicitly provisional until an
OFF/ON pilot measures overhead and coverage. Observed raw RAM includes cache; sampled peak and
kernel peak are different fields. First/reset/missing CPU intervals remain unknown.

The bounded private atomic trace file lives under the existing `brain` product resource,
separately from the Run SQLite ledger and `acceptance_metrics`. Its path is registry configuration,
not a host home path. Shared locking serializes writers; retention and size eviction carry a
trim watermark. Replay deduplicates samples; unknown/dropped writes never imply complete coverage.
A failed write is buffered as a gap for the next successful write. If the process or disk prevents
that marker, the reader still reports partial/unavailable/stale, never full recording.

The current scoped worker inspect contract carries `resources` to CLI, SDK, MCP and monitor.
Per-Attempt `read-output` authority precedes the trace read, including finished workers; denied
workers carry no resource values. Text carries state, sample age, null values and gap reason;
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

Task evaluation uses the same authorized cost projection, pinned to its receipt's Run revision
even on replay. `costReport.observedAtMs` is the current sampling instant, separate from the
immutable evaluation/admission/cancellation receipt; independent reads may have different
sampling instants. Supplemental cost-metric corruption produces `run-cost-unavailable` and
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
