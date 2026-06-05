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

Releases follow [SemVer](https://semver.org/); the first release is `0.1.0`. While
in `0.x`, minor versions may include breaking changes. The
[`CHANGELOG.md`](./CHANGELOG.md) is hand-maintained in the _Keep a Changelog_
format — update it in the same change that bumps the version.

penstock publishes via npm **trusted publishing (OIDC)**: no long-lived tokens are
stored anywhere, and from `0.1.1` onward every release carries automatic
provenance. Provenance requires a **public** repository. Two workflows back this:

- [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) runs the full gate suite
  on Node 20, 22, and 24 for every push to `main` and every pull request, plus an
  informative `npm audit`.
- [`.github/workflows/release.yml`](./.github/workflows/release.yml) publishes to
  npm when a GitHub **Release** is published. It is granted only
  `contents: read` + `id-token: write` and never commits back to the repo.

### One-time setup (project owner)

npm cannot publish the _first_ version of a brand-new package over OIDC — the
package must already exist before a Trusted Publisher can be configured. So `0.1.0`
is published manually; from `0.1.1` on, `release.yml` does it automatically.

1. **Create the public GitHub repo** and push `main` (a public repo is required for
   provenance).
2. **Confirm the npm name is free** (`npm view penstock`). If it is taken, switch to
   the scoped name and update `name`, `repository`, and `exports` accordingly.
3. **Publish `0.1.0` manually:** `npm login` (with 2FA), then `npm publish`. This
   first version will **not** carry provenance.
4. **Configure Trusted Publishing** on npmjs.com → the package's **Settings** →
   enable Trusted Publishing with GitHub (OIDC), matching your org/user, repo, and
   the `release.yml` filename (and the `npm` Environment, if you use one). Fields
   are **case-sensitive**; select `npm publish` as the allowed action. Optionally
   create an `npm` GitHub Environment with required reviewers for an approval gate.
5. **Harden:** enable 2FA on npm and GitHub, set the package's publishing access to
   **require two-factor authentication and disallow tokens**, and enable GitHub's
   private vulnerability reporting (see [`SECURITY.md`](./SECURITY.md)).

Trusted publishing also requires npm ≥ 11.5.1 and Node ≥ 22.14.0 — both are pinned
in `release.yml`.

### Each subsequent release (`0.1.1`+)

1. Bump the `version` in `package.json` and add a dated section to `CHANGELOG.md`.
2. Commit and push.
3. Create a **GitHub Release** for the new tag — this triggers `release.yml`, which
   publishes to npm with provenance.

## Security

Please **do not** open public issues for vulnerabilities. See
[`SECURITY.md`](./SECURITY.md) for how to report one privately.
