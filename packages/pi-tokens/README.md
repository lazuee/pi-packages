# Tokens

Registers a `tokens` tool that reports the token count of the current session.

The tool takes no parameters and returns:

- live context usage: estimated prompt tokens, the model's context window and the percentage used
- total billed tokens so far, summed over the assistant messages on the current branch

Context size is `unknown` right after a compaction until the next assistant response.
The same object is returned as structured content, so a `codemode` script can read
`context`, `contextWindow`, `percent`, `billed` and `assistantMessages` directly.

## Install

```sh
pi install npm:@lazuee/pi-packages
```
