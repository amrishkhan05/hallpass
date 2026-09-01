# Security

Hallpass treats agent output, shell requests, generated code, and repository prose as untrusted. Approved configuration, the installed Hallpass executable, and protected CI are the enforcement boundary; policy changes and exceptions are human-controlled.

Hallpass is not an operating-system sandbox. A process that can bypass hooks, replace the executable, rewrite CI, or push around branch protection can bypass local enforcement. Git hooks are advisory; protected CI is the final gate. Shell rules in v0.1 use explicit configured command fragments and are not a complete shell parser.

Repository instruction text is parsed as data and never executed. Future semantic analyzers must isolate repository prompt content and label uncertain conclusions as heuristic or semantic. Third-party executable detectors are not supported in v0.1 because they expand the supply-chain trust boundary.

Report vulnerabilities privately through GitHub's security advisory feature at `github.com/amrishkhan05/hallpass/security/advisories/new`. Do not include secrets or private source code.
