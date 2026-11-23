# Fast makefun-site

A faster drop-in replacement for makefun-site 1.0.0 (make.fun's own static
site generator), written for the "Build a static site faster" bounty
(`site-generator-speed-01-run-20261122`).

`run(input)` returns exactly the output tree makefun-site 1.0.0's `build`
returns for the same input — every page's `index.html`, the index and tag
pages, `build-report.txt` and every static file, byte for byte. Pure
JavaScript, stdlib only: no dependencies, no native code, no Wasm,
deterministic, nothing cached from one case to the next.

## Files

- `solve.js` — the entry: `run(input)`, a self-contained re-implementation
  of the makefun-site pipeline with the hot paths rewritten (see below).
- `main.ts` — the harness driver, unchanged from the house baseline: reads
  `/input/cases.json`, answers each case with `run`, writes
  `/output/answers.json`. Turns V8's incremental marking off, as the
  baseline does.
- `LICENSE` — MIT.

## How it is faster

Profiled against the baseline on the practice set (CPU profile +
`fast-anything scan`):

| Hot spot in the reference | Fix in `solve.js` |
|---|---|
| `escapeHtml` called once per character by the inline renderer (~20% of CPU) | Inline renderer gathers plain-text runs and escapes each run once; `escapeHtml` returns early when a run holds no special character; code-block lines are escaped as one block |
| Inline renderer walks every character in JS | The next construct starter is found by one regex search instead of a per-character loop (faster when cold, which is how the heat runs) |
| `slugify` runs NFKD normalise + a Unicode-mark strip on every title/tag/heading | ASCII fast path (normalise + mark-strip are identity on ASCII, ~95% of titles/tags); per-build memo; each tag's slug computed once, not three times |
| Lexer runs ~8 regexes per line | First-character dispatch: most lines run no regex at all; the regexes that can still match are the reference's own |
| Front matter re-joins the whole body; `\r\n` replace on every file | Body taken by offset slice; `\r` normalisation skipped when the file holds no `\r` |
| `wordsOf` builds a match array per body | Exact manual word count (same `\s` set as `/\S+/g`, no allocation) |
| Each post's card built twice (once for the cards map, once for its page) | Built once, reused |
| Template renderer walks a node tree with a switch + recursion per node | Templates are compiled once per build into straight-line functions (mechanical translation of the same walk); the interpreter stays as a fallback if compilation is unavailable |

Every optimisation is provably output-identical to the reference; the
risky ones (inline scanning, slug fast path, line classification, template
compilation) were differentially tested against the reference (see below).

## Measured speed

Practice set (3 cases, 250/340/480 Markdown sources), this machine, CPU
time of the whole `main.ts` run, 10 runs each, median:

- House baseline (makefun-site 1.0.0): **1265 ms**
- This entry: **675 ms**
- **Speedup: ~1.87x end to end** (~2.3x on the build alone, cold)

Three freshly drawn instances (9 unseen cases, different seeds): baseline
1370/1380/1450 ms vs this entry 800/770/800 ms — 1.71x, 1.79x, 1.81x.

## Correctness

- Practice set: scorer `passed 1, cases_passed 3/3`; `answers.json`
  byte-identical to the baseline's.
- 9 freshly generated cases (3 new seeds via the kit's own generator):
  all byte-identical to the baseline, all pass 3/3. These cover drafts
  (~50–60 per case), refusals (~20–30), 300+ broken links, slug
  collisions and non-ASCII titles per case.
- 440 differential cases against the reference (26 hand-written
  adversarial Markdown bodies, 14 tricky templates, 400 random fuzz
  bodies over a nasty alphabet incl. Unicode whitespace): 0 failures.
- Two runs on the same input produce byte-identical `answers.json`
  (deterministic, as the harness requires).

## Notes

- Node 22 compatible: only stable stdlib features (the graders run Node 22;
  this machine has Node 24, so Node 22 was not run directly).
- `fast-anything` was installed (`npm i -g @el4cteo/fast-anything`) and
  used for profiling only (`scan`, `doctor`); no Rust code is in the entry
  and no Rust toolchain exists on this machine, so nothing was ported.
  `craft-anything` was not built (needs Rust 1.97+; this machine has no
  Rust toolchain and ~400 MB free memory).
