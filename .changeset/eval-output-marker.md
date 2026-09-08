---
"@leandown/core": patch
---

Distinguish `#eval` / `#check` results from source. Every line of the output is
now prefixed with `>> `, and the output renders in grey (a new `--lean-output`
variable) instead of the blue used for proof-state markers.
