# Contributing to Hallpass

Thanks for helping improve Hallpass.

## Development setup

Use Node.js 20.19 or newer.

```bash
npm ci
npm test
npm run build
```

For the full validation path before opening a PR:

```bash
npm run check
```

## Contributor rules

- Keep changes minimal and scoped to the requested problem.
- Prefer existing utilities, stdlib behavior, or repository patterns before introducing new abstractions.
- Do not add dependencies unless the project truly needs them.
- Keep detectors deterministic, isolated, and evidence-producing.
- Semantic or heuristic uncertainty must not masquerade as a blocking fact.
- Add the smallest regression test that proves new non-trivial logic.
- Preserve provenance: rule source, file, and line information should remain intact when compiled or reported.
- Never bypass the approval boundary for governance or protected files.

## Pull request expectations

- Open a focused PR with a clear problem statement and solution.
- Include a brief summary of why the change is needed.
- Reference the issue or problem being addressed when applicable.
- Include tests covering the changed behavior.
- Keep the diff small and reviewable.
- Avoid unrelated refactors or opportunistic cleanup in the same PR.

## Reporting false positives or policy issues

False-positive reports should include:

- Hallpass version
- rule ID and classification
- repository pattern that triggered it
- expected result
- actual result
- minimal reproduction

Use the false-positive issue template in [.github/ISSUE_TEMPLATE/false-positive.yml](.github/ISSUE_TEMPLATE/false-positive.yml).

## Release and publishing

This project publishes on pushes to the main branch through the workflow in [.github/workflows/publish.yml](.github/workflows/publish.yml). Use a clean, tested main branch before release.

## Code of conduct

Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before contributing.
