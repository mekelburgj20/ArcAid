# Per-version release notes — convention retired

This directory carries per-version release notes for ArcAid `v2.0.0` through
`v2.2.8` as a historical record. The convention of writing a dedicated
`releases/v<version>/README.md` for each release was retired as of v2.3.0+.

Going forward, **all release detail lives in [`../CHANGELOG.md`](../CHANGELOG.md)** —
single source of truth, no double-maintenance. The CHANGELOG entries from
v2.3.0 onward carry the same level of detail (problem, fix, files touched,
migration notes) that the per-version files used to.

## Why

The per-version files duplicated CHANGELOG content, drifted apart over time,
and added work to every release without paying for itself. Eight releases
(v2.3.0 → v2.5.2) shipped without per-version dirs and the CHANGELOG carried
the load fine.

## What's preserved

The existing v2.0.0 → v2.2.8 directories stay in place as a historical
archive. Don't add new ones; don't bother backfilling the gap.
