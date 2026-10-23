# Distribution-shift report

Rows: train 1061 · test 1061
Date range: train 2025-04-01 → 2026-03-28 · test 2025-04-01 → 2026-03-28
Missing columns: none
New columns: none
New types: none
New departments: none
New grades: none
New currencies: none
Null-rate increases: none
Duplicate-ID rate: train 0.1% · test 0.1%

| Rule | Train fail % | Test fail % | Train NE % | Test NE % |
| --- | --- | --- | --- | --- |
| R01 | 10.59 | 10.59 | 2.35 | 2.35 |
| R02 | 0.19 | 0.19 | 0.09 | 0.09 |
| R03 | 4.05 | 4.05 | 2.03 | 2.03 |
| R04 | 6.98 | 6.98 | 6.98 | 6.98 |
| R05 | 50 | 50 | 50 | 50 |
| R06 | 0.14 | 0.14 | 0.09 | 0.09 |
| R07 | 5.21 | 5.21 | 1.04 | 1.04 |
| R08 | 0.09 | 0.09 | 0.09 | 0.09 |
| R09 | 0.32 | 0.32 | 0.96 | 0.96 |
| R10 | 9.01 | 9.01 | 0.9 | 0.9 |
| R11 | 0.9 | 0.9 | 1.8 | 1.8 |
| R12 | 0.19 | 0.19 | 0.09 | 0.09 |
| R13 | 2.48 | 2.48 | 0.5 | 0.5 |

## Actions
- Investigate rules with a not-evaluable rate above 1%.
