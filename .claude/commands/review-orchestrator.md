# Design Review Orchestrator

Run a comprehensive review of a UI component or page by executing three focused review passes. After each pass, fix the issues found before proceeding to the next.

## Target

Review the component or page specified by the user. If a design reference exists (HTML mockup, screenshot, or description), use it for the design fidelity pass. If no reference exists, skip Pass 1 and start with UX.

## Review Sequence

### Pass 1: Design Fidelity (skip if no reference)
If the user has provided a reference design (mockup, screenshot, or HTML file):

1. Read the reference file(s)
2. Compare the current implementation against the reference following `.claude/commands/review-design-fidelity.md`
3. Fix all critical and major deviations before proceeding
4. Log what was fixed

### Pass 2: UX Review
Review usability and player experience.

1. Follow the review process in `.claude/commands/review-ux.md`
2. Pay special attention to:
   - Mobile layout at 375px and 390px widths
   - Visual hierarchy and readability
   - Cognitive load (minimize decisions required)
3. Fix all critical and major issues before proceeding
4. Log what was fixed

### Pass 3: Code Quality
Clean up the code.

1. Follow the review process in `.claude/commands/review-code-quality.md`
2. Focus on:
   - Tailwind idiomacy
   - Component extensibility
   - Edge cases (missing images, few items, long text)
3. Fix all critical and major issues
4. Log what was fixed

## Final Report

After all passes, output a summary:

```
═══ REVIEW COMPLETE: [Component/Page Name] ═══

Pass 1 — Design Fidelity
  [Component]: [X]% match (or "Skipped — no reference")
  Issues found: [N] | Fixed: [N] | Remaining: [N]

Pass 2 — UX Review
  Scores: hierarchy [1-5] | cognitive-load [1-5] | mobile [1-5] | a11y [1-5] | consistency [1-5]
  Issues found: [N] | Fixed: [N] | Remaining: [N]

Pass 3 — Code Quality
  Scores: tailwind [1-5] | extensibility [1-5] | cleanliness [1-5] | perf [1-5] | edge-cases [1-5]
  Issues found: [N] | Fixed: [N] | Remaining: [N]

Overall: READY TO SHIP / NEEDS ANOTHER PASS
═══════════════════════════════════════════════
```

If any category scores below 3 or design fidelity is below 90%, the verdict is NEEDS ANOTHER PASS. Re-run this orchestrator until all thresholds are met.
