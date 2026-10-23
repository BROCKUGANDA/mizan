# MIZAN — challenge submission

| Deliverable | Where | Status |
| --- | --- | --- |
| Working prototype | [github.com/BROCKUGANDA/mizan](https://github.com/BROCKUGANDA/mizan) — runnable repo, setup below | public, MIT, `main` only, no CI actions |
| Flagged exceptions for the test file | `bun run mizan hidden-test <file>` → `findings.csv` + `data_quality.csv` + `run-manifest.json` | command proven on the training pack (see `findings-training-pack/`) |
| Demo video ≤ 3 min | Hosted: [youtu.be/QE2QcfPyz8Y](https://youtu.be/QE2QcfPyz8Y) · source `mizan-demo.mp4` — 2 min 40 s, 1080p, narrated and captioned | included |
| Solution note ≤ 2 pages | `mizan-solution-note.pdf` — 2 pages A4, includes the responsible-AI statement | included |
| Pitch deck | `mizan-pitch-deck.pdf` (10 slides) · `pitch-deck.html` (same deck, navigable) | included |

## Prototype setup

```bash
git clone https://github.com/BROCKUGANDA/mizan && cd mizan
bun install
bun run seed     # generates the synthetic pack (seed 42) and loads SQLite
bun run build
bun run start    # http://localhost:3000
```

Verification gates: `bun run verify` (12 assurance gates), `bun test` (72 tests),
`bun run typecheck`, `bun run lint`.

Judge accounts are switched from the header role switcher — Analyst A, Analyst B,
Team Lead, Operations Owner, Policy Author, Policy Approver, Auditor, Compliance
Lead, Administrator. No login: the sandbox has no real credentials, and the role
is checked server-side on every write.

## Flagged exceptions for the released test file

The unlabelled test file is released three days before the deadline, so it is not
in this repository and no findings for it are claimed here. When it arrives:

```bash
bun run mizan hidden-test path/to/test-file.csv --employees path/to/employees.csv
```

Writes `output/hidden-<input-sha>/` containing `findings.csv` in the supplied
finding format, `data_quality.csv`, a `run-manifest.json` with the input hash,
engine/pack/calendar hashes, census counts, output hash and findings SHA-256, and
a `shift_report.md` comparing the file against the training distribution. The
command exits non-zero unless the census balances, the format validator passes and
two evaluations agree byte-for-byte — so a submission cannot be produced from a
run that failed its own checks.

`findings-training-pack/` is that output for the **training** pack, included as
proof of the format and of reproducibility: 1,061 transactions × 15 clauses =
15,915 checks, 49 findings, 13 data-quality rows, output hash
`ecefa394f4d1237fe2ff513324d563d703dac5346e0a1cfd61cd50ab3dcd0a26` — the same
hash the running server reports for the same inputs, which is the check that the
offline scoring path and the product agree.

## Contents of this folder

- `mizan-demo.mp4` — 2:40, 1920×1080, H.264/AAC, burned captions. Published at
  <https://youtu.be/QE2QcfPyz8Y>. SHA-256 `483608dc8ab287e34d2739f6f6d56e39e53033b0af363961949098543d4c830f`
- `mizan-solution-note.pdf` — 2 pages A4. SHA-256 `e1f0311f2148eb2c6719da547595ab71e99b041fa98f3469f7092b3e719c311f`
- `mizan-pitch-deck.pdf` — 10 slides, 16:9, with the repo and video links on the
  title, evidence and closing slides; `pitch-deck.html` is the same deck for
  presenting from a browser
- `findings-training-pack/` — findings CSV, data-quality CSV, run manifest, shift report

Synthetic data only. MIZAN holds no credentials for any HR system and has no
write path to one.
