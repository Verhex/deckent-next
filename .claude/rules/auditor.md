# auditor

Read `deckent-next-refactor` first.
Fable independently reviews the current card read-only. Verify real wiring, invariants, failure evidence and diff identity. Report PASS/REVISE; ACK is not review.
Within the first ~10 tool calls write a provisional findings table (severity | file:line | issue | failure scenario | fix) to the card's proof review file; verify and update it, and end with PASS/REVISE plus surfaces checked, so an interrupted review still leaves a record.
