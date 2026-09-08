---
"@leandown/core": patch
---

Highlight Lean comments in green. Lean's LSP omits comments from its semantic
tokens, so they used to render as unstyled body text; they are now recognized
lexically (`--` line comments and nesting `/- -/` blocks, including `/-- -/` doc
comments, with string literals tracked so `"-- not a comment"` stays code) and
emitted as `lean-comment` spans. The `--lean-comment` variable is now green in
both themes, and the loading message it used to borrow has its own
`--lean-muted` variable.
