# CI and quality policy

The standalone repository enforces the same policy as the Animu app. Install
with `pnpm install --frozen-lockfile`, then run:

```sh
pnpm verify          # every check, as CI runs it
pnpm verify --fast   # skips the slow ones (secrets, dependency audit)
```

`pnpm verify` (`scripts/verify.mjs`) runs every step even after one fails and
ends with a summary of all of them. `pnpm run check:ci`, which GitHub Actions
and Jenkins call, is the same script, so a local run and CI cannot drift apart:

- Secrets: complete Git history and current tracked/unignored files.
- Regression tests for the gate tooling.
- Dependency audit: unreviewed high/critical findings fail; registry failures fail
  closed. Narrow, version/path-specific exceptions match the app and remain visible.
- Lint, each with zero warnings allowed (`pnpm run lint` runs all three):
  ESLint with SonarJS production-code rules (`lint:eslint`), oxlint's
  type-aware rules run by tsgolint, the app's rule set (`lint:types`), and knip
  for unused files, exports and dependencies (`lint:deps`).
- TypeScript checks, unit tests and enforced coverage floors.
- ESM and CommonJS builds.

`pnpm run check:quality` (`verify --no-secrets`) omits only Git-history scanning
so the app can call it inside its isolated source copy; the app performs the
full history scan before checking its submodules. Neither entry point requires
the app checkout or its dependencies.

A finding oxlint gets wrong (a flag set in a callback, which TypeScript's
narrowing does not follow) is disabled on its line with the reason:
`// oxlint-disable-next-line <rule> -- <why>`.

Coverage floors are **89% statements, 77% branches, 90% functions, 90% lines**. They must only
increase. LCOV (`coverage/lcov.info`) feeds SonarQube, and `CI=true` also emits
`junit.xml`. Jenkins publishes test results; both CI services retain coverage.

GitHub Actions also runs CodeQL security-and-quality queries on JS/TS and workflow
code on PRs, main pushes, merge queues and weekly schedules. Dependabot covers npm
and Actions dependencies. The npm publish workflow reruns all quality gates before publication.

## SonarQube on Jenkins

`Jenkinsfile.sonar` is the standalone analysis pipeline. Configure a Pipeline from
SCM job in the Animu folder with this repository, branch `*/main`, full Git history,
and script path `Jenkinsfile.sonar`. Run it once to register its five-minute SCM
poll. The host agent label is `animu-android-native`; it needs the repository's
Node/Corepack toolchain, Docker, and `~/sonarqube/analysis-token` (mode 600).
No credentials belong in the repository.

The project uses the app's **Sonar way** gate, JS/TS profiles and previous-version
new-code definition. The scanner waits for the server result; unavailable analysis
or a rejected quality gate fails the job. GitHub-hosted runners cannot reach this
host's local SonarQube, so server analysis runs in Jenkins, as it does for the app.

Public compatibility type aliases and non-security retry jitter have narrowly documented SonarJS exceptions; cognitive complexity remains enforced.

A passing CI job is distinct from GitHub merge enforcement: repository branch
protection/rulesets must require the relevant checks if direct pushes and merges
with failed checks are to be blocked. This rollout mirrors the app's job gates;
it does not silently introduce a different branch-protection policy.
