# ADR-0005: Exception identity and duplicate rows

Status: accepted

## Decision
exceptionKey = SHA-256(tenant ‖ txnId ‖ ruleId ‖ clauseId). A txnId repeated with
different content evaluates under rowIds `TXN-…#n` (DQ-008) so keys never collide;
exports use the original ID. Re-runs upsert and append observations; a changed
evidence hash reopens closed exceptions.
