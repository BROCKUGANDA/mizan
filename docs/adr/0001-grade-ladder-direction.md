# ADR-0001: Grade ladder direction and ordinals

Status: accepted · Date: seed

## Context
Rules compare grades ("grade 13 or above"). The pack defines the direction.

## Decision
`grade-ladder-1.1.0`: ordinal equals the grade number; higher ordinal = more senior
("grade 20 is the most senior" — R14 definition). Grades not on the ladder
(e.g. "13A") yield DQ-011 and NOT_EVALUABLE for grade comparisons.

## Consequences
Both directions are testable by changing the config; tests run in the pack direction.
