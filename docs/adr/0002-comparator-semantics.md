# ADR-0002: Comparator semantics are fixed up front

Status: accepted

## Decision
"above / over / more than" = strictly greater. "at least / or above" = inclusive.
"within N days" includes day N. Calendar days unless the rule says business days
(versioned UAE calendar, effective-dated weekends).

## Evidence
Worked example WX-1001 (R04): AED 10,000.00 exactly is NOT_APPLICABLE; 10,000.01 fails.
EC-G01/EC-F01 fixtures pin the boundaries.
