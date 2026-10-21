# Regression corpus

Every fixed defect lands here as a fixture directory with input rows and the
expected finding set. The mutation/near-miss/boundary fixtures live in the
generator (`src/lib/pack/generate.ts`): TXN-BND-0001..0005 (thresholds),
TXN-SEQ-0001 (sequence), TXN-TRF-0001 (chain), TXN-REF-0001/0002 (reference
integrity), TXN-VB-0001 (value bounds), TXN-DQ-0004..0021 (DQ catalogue),
TXN-70001 (duplicate ID), TXN-NOAPP-0001 (empty approvals).
