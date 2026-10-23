# ADR-0003: Duplicate rule flags the later twin

Status: accepted

## Decision
R11 flags the later entry (effective date, then submission time, then row ID) and
cites the earlier one; reversed pairs are excluded. `flag: both` was considered and
rejected (noisier, same root cause).

## Evidence
Worked example WX-1006 (later twin flagged, cites WX-1005).
