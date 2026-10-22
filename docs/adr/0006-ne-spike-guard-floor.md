# ADR-0006: Not-evaluable spike guard sample floor

Status: accepted

## Decision
The FS-07 "NE rate above 5% of applicable" test applies when a rule has ≥ 50
applicable checks; below that, the 3×-baseline count test applies. Prevents
2-of-2 denominators from permanently flagging the run COMPLETED_WITH_DQ.
