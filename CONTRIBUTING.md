# Contributing to penstock

Thanks for your interest in penstock. This guide covers local development, the
quality gates, and how releases and security reports are handled.

## Development setup

penstock targets Node `>=20`; **Node 22+ is recommended** (`.nvmrc` pins `22`).

```sh
git clone https://github.com/zaier84/penstock.git
cd penstock
npm ci
```

`npm ci` installs from the committed lockfile for a reproducible, integrity-checked
install. penstock has **zero runtime dependencies** — everything installed is dev
tooling.

## Quality gates

Every change must keep all of these green (CI enforces them on Node 20, 22, and 24):

```sh
npm run format:check   # prettier
npm run lint           # eslint (typescript-eslint)
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run coverage       # vitest run --coverage (>= 95%)
npm run build          # tsup → ESM + CJS + .d.ts
npm run check:exports  # publint + @arethetypeswrong/cli
```

Use `npm run format` to auto-fix formatting. Tests live in `test/`; where a unit is
test-driven, write the test first. Coverage thresholds are 95% — treat gaps as
missing tests, not as something to silence.

## Examples

The runnable examples import from local source and double as living documentation:

```sh
npm run example:order
npm run example:onboarding
```

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) — e.g. `feat:`,
`fix:`, `test:`, `docs:`, `chore:`, `refactor:`. Keep each commit focused.

## Release

Releases are **manual** and follow [SemVer](https://semver.org/); the first release
is `0.1.0`. The [`CHANGELOG.md`](./CHANGELOG.md) is hand-maintained in the _Keep a
Changelog_ format — update it in the same change that bumps the version. From
`0.1.1` onward, publishing runs through GitHub Actions via npm **trusted publishing
(OIDC)** with automatic provenance; no long-lived tokens are stored. The detailed
publish runbook is maintained by the project owner.

## Security

Please **do not** open public issues for vulnerabilities. See
[`SECURITY.md`](./SECURITY.md) for how to report one privately.
