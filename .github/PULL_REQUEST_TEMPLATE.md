## What this changes

<!-- What the change does, and why. If it fixes a bug, say what was wrong. -->

Closes #

## Type of change

<!-- Tick what applies. -->

- [ ] Bug fix (no API change)
- [ ] New feature (additive)
- [ ] Breaking change (behaviour or API differs)
- [ ] Documentation only
- [ ] Tooling, CI, or benchmarks

## Tests

<!--
Which tests cover this, and where. New behaviour needs new tests; a bug fix
needs a test that fails without the fix. If this is documentation only, say so.
-->

## Quality gates

All of these must be green — CI runs them on Node 20, 22, and 24.

- [ ] `npm run format:check`
- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run coverage` (≥ 95%)
- [ ] `npm run build`
- [ ] `npm run check:exports`

## Checklist

- [ ] Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
      (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`)
- [ ] `CHANGELOG.md` updated, if this changes anything a user would notice
- [ ] Documentation updated, if this changes or adds public API
- [ ] No new runtime dependencies — penstock ships with `dependencies: {}`
- [ ] No `ctx.input` or context values reach a log line or a trace attribute

## Anything reviewers should know

<!--
Trade-offs you made, alternatives you rejected, or parts you are unsure about.
Saying "I am not sure this is the right approach" is welcome and saves time.
-->
