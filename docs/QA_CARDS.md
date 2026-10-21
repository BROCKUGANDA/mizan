# Judge Q&A cards

**Measured precision / recall?** Precision is computed with a Wilson lower bound
on decided exceptions (shown on the Overview). Recall is proven on the golden set:
all five worked examples plus mutation/near-miss fixtures are detected 5/5
(`bun run mizan verify`).

**Architecture?** One deterministic engine (pure functions, integer fils, canonical
JSON, SHA-256), a normalisation pipeline with DQ codes, a human decision workflow
with countersign and conflict-of-interest guards, a hash-chained audit trail, and
a bilingual (EN/AR RTL) interface. The model is optional and only polishes wording.

**Pilot plan?** 12 weeks: onboard → baseline → 4 weeks shadow (≥90% measured
precision target) → assisted → full → go/no-go. Weekly metrics from PRD §6.3.

**Running cost?** No AI cost with `ai.mode=none` (default). One VM for the pilot
(compose); the engine evaluates 15,915 checks in seconds on a laptop; a local
model is optional on a GPU node.

**What if the model provider dies mid-demo?** Nothing breaks: the breaker opens,
the system shows M1, and explanations continue from approved templates.

**Can we trust the output?** Determinism: same inputs → same bytes (verified
2 runs + 2 machines). Census reconciliation is asserted at finalize. Exports are
validated against the 5 worked examples before download.
