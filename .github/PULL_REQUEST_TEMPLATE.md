## Card and candidate

- Owner-admitted PLAN card id:
- Branch (`lane/<card>`, worker `lane/<card>-<runId>` or `release/<version>`):
- Base commit / candidate commit:
- Author / worker run id (if applicable):

## Scope and resulting behavior

Describe the problem, what changes for the user and the bounded file/contract ownership.
For worker delivery, identify the retained patch and final report; preserve attribution.

- [ ] Material AI assistance briefly disclosed below (or stated as none); I can explain the change, ran the relevant checks and take responsibility for it.
- AI assistance (what it helped with, or none; prompts/transcripts are not required):

## Checks run

List **exact commands**, exit codes/results, candidate SHA and retained proof location.
State skipped/unavailable checks with reasons; planned checks are not passed checks.

| Exact command | Result / evidence |
|---|---|
| | |

## Independent review

- Status: pending / unavailable / PASS / REVISE (exact scope and revision):
- Independent reviewer and evidence link:
- Blocking findings and resolution:

Author checks, worker reports, Jev and CI do not constitute independent PASS.
Landing remains the lead's gate: independent review + targeted checks and owner authorization.

## Risks, limits and next step

Include relevant negative/failure evidence, unverified surfaces and concrete follow-up ownership.

- [ ] Affected ARCHITECTURE/PLAN/core-memory claims reconciled; manifest refreshed if edited.
- [ ] Concurrent WIP preserved; no proprietary Enterprise sources/history/artifacts exposed.
- [ ] DOGFOOD/live untouched (if changed under explicit admission, describe that authority and proof).
- [ ] No Git credentials inside worker containers; pushes/PR opening belong to lead host tooling.
