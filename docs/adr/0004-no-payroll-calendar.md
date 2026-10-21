# ADR-0004: Closed-payroll-period modifiers are skipped without a calendar

Status: accepted

## Decision
The pack provides no payroll calendar. Severity modifiers that need one
(duplicate both-effective → Critical; timing closed-period raise) are not applied,
and the stored rationale says so explicitly. Never invent a fact.

## Consequences
Add config/payroll-calendar.yaml to activate; no code change.
