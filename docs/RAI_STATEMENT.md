# Responsible AI statement

**The engine decides, the model explains — and the model is optional.**

1. **Deterministic detection.** Every exception comes from a compiled, tested,
   human-approved rule. The engine is pure TypeScript: no wall clock, no
   randomness, no network, no model code. The same inputs produce the same bytes.
2. **The model never decides, scores, routes or closes anything.** The optional
   model gateway only rewrites explanations, is fact-locked against the evidence
   (every number, date and ID must come from the evidence; accusatory terms are
   rejected), falls back to the canonical template on any failure, and is off by
   default (`ai.mode=none` → explanations continue from approved templates).
3. **Free text is data, never instructions.** CSV text is quoted data; the engine
   never reads it for decisions; instruction-like text is tagged DQ-017 for
   security review.
4. **Humans decide.** Nothing closes automatically. Dismissing High/Critical
   findings needs a second analyst; conflict-of-interest refusals are enforced in
   the API and audited.
5. **No individual scores.** Exceptions describe transactions and controls, not
   character. No personal risk scores exist anywhere in the data model. Pattern
   alerts are advisory, visible to compliance roles only, never exported or
   routed, and exclude protected attributes.
6. **Fairness monitoring.** Exception rates by department and location are shown
   with Wilson intervals; cells below 5 are suppressed and hatched.
7. **Synthetic data only.** The demo and hosted build run on a seeded synthetic
   pack; a PII scanner blocks uploads containing Emirates ID, passport, IBAN,
   phone or email patterns.
8. **Traceable or not shown.** Every exception carries the rule ID, version,
   verbatim clause, evidence values and the run manifest; the audit trail is
   hash-chained and tamper-evident (a failed verification enters safe halt).
