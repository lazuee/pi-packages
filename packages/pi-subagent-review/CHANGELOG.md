# Changelog

## 0.0.1

- Initial release.

Unreleased:

- A failed or empty reviewer run reports its error instead of "No actionable issues found".
- Findings survive renderer parsing: the `[level] path:range` tag is fenced instead of being read as an open code span.
- An idle session says the findings are ready, and triage starts from them.
- Repositories with no commit yet are reviewed instead of aborting on `HEAD`.
