# penstock — Claude Code Operating Guide

`penstock` is a **zero-runtime-dependency Node.js/TypeScript** library for composable backend workflows (**use-cases → pipelines → steps → engines**) with first-class **rollback / compensation**, published to npm as a **dual ESM + CJS** package.

This file is the always-on operating contract. It is intentionally short. The full detail lives in the spec.

## Source of truth — read this first

`BUILD_SPEC.md` (repo root) is the **authoritative, complete specification**: every design decision, the full public API, exact configuration, and the phased build plan. **It is the source of truth; this file only governs how you operate.**

**Before you start any phase, open `BUILD_SPEC.md`, re-read that phase (section 7) and every section it references, and implement exactly what it says.** Do not work from memory of the spec — re-read it.

## Do not invent — this is the most important rule

- The spec's decisions are **final**, especially section 1 (resolved decisions) and section 1.10 (security invariants). Do **not** re-open them, "improve" them, or substitute your own alternatives.
- Do **not** hallucinate or guess an API, method, option, flag, file, dependency, script, or config that the spec does not specify. If it isn't in the spec, it doesn't exist.
- If something is genuinely impossible, self-contradictory, ambiguous, or missing, **stop and ask me.** Never improvise a design or fill a gap silently.
- Do **not** add features, files, dependencies, or tooling beyond what the spec lists. If you believe something is needed, ask me first.

## How we work — strictly phase by phase

1. Do **one phase at a time** (section 7, Phases 0–8). Never jump ahead or batch phases together.
2. Where the spec marks a phase **TDD**, write the tests **first**, then implement until they pass.
3. At the end of each phase: confirm that phase's quality gates are green, **commit** (rules below), give me a short summary (done / next), then **stop and wait for my explicit approval** before continuing.
4. Never begin the next phase without my go-ahead.

## Commits & authorship — hard rules for every commit

- **Commit after each phase**, once green. Use **Conventional Commits** (`feat:`, `fix:`, `test:`, `chore:`, `docs:` …).
- **Every commit is authored as me.** In Phase 0, check `git config user.name` and `git config user.email`; if they are not already mine, **ask me** for them and set them locally for this repo. Never commit under a Claude / AI identity.
- **No AI attribution, anywhere.** Do **not** add `Co-Authored-By:` trailers, "Generated with Claude Code" footers, or any similar line to commit messages or files. I must be the sole author and contributor.
- **Never push.** Do not add, configure, or push to any git remote — I push myself.
- Do **not** configure anything that commits on my behalf (no release bots, no semantic-release auto-commits, no changelog bots).

## Never run these — they are mine to run

`git push`, `npm publish`, `npm login`, creating accounts, configuring git remotes, or any other credentialed or irreversible action. **Prepare** the exact commands and give me a runbook; **I** execute them. Publishing uses **OIDC trusted publishing triggered by me** (section 7 Phase 8, section 12) — no stored tokens, and you never publish.

## Security invariants — NON-NEGOTIABLE (section 1.10; all runtime code)

- **No dynamic code execution:** no `eval`, `new Function`, `vm`, or dynamic `import`/`require` of any user-derived specifier. Only ever invoke functions the user explicitly passed in.
- **No I/O or telemetry in runtime code:** no network, no filesystem, no environment scanning, no analytics. Zero data-exfiltration surface. (Dev/CI tooling is separate.)
- **Prototype-pollution safe:** all name-keyed lookups use `Map`/`Set` or null-prototype objects — never a plain object keyed by user input. Reject any name equal to `__proto__`, `prototype`, or `constructor` with a `UsageError`.
- **No sensitive data in logs:** never log `ctx.input` or context values — only names, statuses, durations, and error message/type.
- **No secrets in the repo:** never hardcode tokens or keys; `.gitignore` excludes `.env*`. Keep any regex ReDoS-safe (simple, anchored; prefer plain string checks).
- Keep `test/security.test.ts` proving prototype-pollution resistance and log hygiene (section 7 Phase 5).

## Locked technical choices (detail in the spec)

- **TypeScript** `strict: true`. **Zero runtime dependencies** — all tooling is `devDependencies`.
- **Dual ESM + CJS** via **tsup**; type/export correctness validated by **publint** + **@arethetypeswrong/cli** — iterate `exports`/`tsup` config until both pass cleanly (section 6.2).
- **Vitest** (+ v8 coverage, ≥95% threshold). **Node `>=20`**; CI matrix **20 / 22 / 24**; local dev on **22** (`.nvmrc`). **MIT** license. **SemVer**, first release **`0.1.0`**.
- Failure model: a structured **`Result`** object, not exceptions (unless `throwOnError`) — section 1.1. Rollback: **best-effort, reverse-order, aggregated** undo errors — section 1.7. Hooks are **observers**; their throws are contained and never alter flow — section 1.8.

## Key commands & "done" definition

- `npm run build` (tsup: ESM + CJS + d.ts) · `npm test` / `npm run coverage` (Vitest) · `npm run typecheck` (`tsc --noEmit`) · `npm run lint` · `npm run format:check` · `npm run check:exports` (publint + attw).
- A phase is **done** only when `lint`, `format:check`, `typecheck`, `test` (≥95% coverage), `build`, and `check:exports` are all green.

## Project map (full structure in section 5)

`src/`: `index`, `step`, `pipeline` (+ rollback), `engine` (+ registry, `EngineAccessor`), `usecase`, `context`, `logger`, `errors`, `internal` (reserved-name guard), `types`.
`test/`: per-unit suites + `security.test.ts` + `types.test-d.ts` + `integration.test.ts`.
`examples/`: runnable via `tsx`, importing from `../src/index.js` (published consumers import from `'penstock'`).
`.github/workflows/`: `ci.yml`, `release.yml`.

---

**In one line:** follow `BUILD_SPEC.md` exactly, one phase at a time, commit as me with no AI attribution, never push or publish, never invent — and when in doubt, stop and ask.
