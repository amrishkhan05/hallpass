# Contributing

Use Node.js 20.19 or newer, then run:

```bash
npm ci
npm run check
```

Keep detectors deterministic, isolated, and evidence-producing. Semantic uncertainty must not masquerade as a blocking fact. Add the smallest regression test that proves new non-trivial logic.

False-positive reports should include the Hallpass version, rule and classification, repository pattern, expected and actual result, and a minimal reproduction.
