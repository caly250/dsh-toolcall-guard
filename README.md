# dsh-toolcall-guard

A DeepSeek Harness (DSH) plugin that catches the case where a
model **writes a tool call into the reply as text** instead of returning a structured tool call,
and turns that broken attempt into a retryable failure so the step is re-run automatically.

```
Without the guard                         With the guard
────────────────────────────────────      ────────────────────────────────────
assistant: Sure! <tool_call>{"name":       assistant: Sure, let me check.
          "ops_bash","arguments":          (tool runs normally)
          {"command":"ls"}}</tool_call>
                                          ↑ the broken attempt was retried
(user sees raw tags, tool never runs)       before it ever reached the chat
```

## The problem

DSH only executes tool calls that arrive as **structured content blocks**
(`message.content[].type === "tool-call"`). Some models behind relay / proxy endpoints
(anything speaking the OpenAI-compatible `chat/completions` protocol) occasionally skip that
channel and paste the invocation into the assistant's prose:

```
<tool_call>{"id":"call_x","name":"ops_bash","arguments":{"command":"pwd"}}</tool_call>
```

The consequences:

- the tag is **not executed** — DSH never sees a `tool-call` block;
- the tag is **shown to the user** verbatim, which looks like a broken client;
- the turn is **wasted** — in the session log it ends with `step/end → turn/end` and no
  `tool/call` event at all.

There is no text-tag parser in DSH to catch this, by design. This plugin adds the missing guard
without touching any upstream file.

## How it works

The plugin hooks the `llm/stream` waterfall — the seam around every streaming model call — and
wraps the chunk stream:

1. it accumulates the `text-delta` chunks of the reply;
2. if the accumulated text matches a **tool-call-as-text** signature, it rewrites that response's
   `finish` chunk into a `EMPTY_RESPONSE` failure;
3. `dsh-llm-retry` (a DSH built-in) sees `EMPTY_RESPONSE` in the provider's `retryableCodes` and
   re-runs the step. Because the attempt ends in `error`, its text is **never committed to the
   session**, so the raw tags never reach the screen.

`EMPTY_RESPONSE` is a built-in, provider-neutral failure code whose documented meaning is exactly
"completed normally but carried no usable content block" — which is what a tool-call-as-text turn
is. That is why it is the right code to raise: a custom code would not be in `retryableCodes` and
`dsh-llm-retry` would pass it straight through.

## Detection is deliberately strict

A false positive would throw away a perfectly good reply, so a candidate only counts when:

- a tag (`<tool_call>`, `<tool_calls>`, `<|tool_call|>`, `[TOOL_CALL]`, …) is **followed by a JSON
  payload** (`{`, `[` or `"`), and
- a bare `{"tool_call": …}` key is **followed by a `"name"` field**, and
- the turn carries **no real structured tool call** — if the model both explained `tool_call` *and*
  made a real call, the turn is left alone.

Zero-width characters (U+200B/200C/200D/FEFF) between the tag name and its brackets are stripped
before matching, because that exact shape has been observed in the wild.

So ordinary prose like *"the model emitted a `tool_call` tag"* is **not** matched.

## Install

You need DSH with the `llm-pi-ai` provider and the `llm-retry` executor (both ship with the
standard desktop profile).

### Option A — clone into a plugin directory, then link (recommended)

```bash
git clone https://github.com/caly250/dsh-toolcall-guard.git ~/dsh-plugins/dsh-toolcall-guard
```

Add the bundle to your profile's `package.json` (`<profile>` is `~/.dsh/profiles/desktop` on a
default install):

```jsonc
{
  "dependencies": {
    "dsh-toolcall-guard": "link:/absolute/path/to/dsh-toolcall-guard"
  },
  "dsh": {
    "profile": {
      "bundles": [
        /* … existing bundles … */
        "dsh-toolcall-guard"
      ]
    }
  }
}
```

Then install the link and reload DSH:

```bash
cd <profile> && pnpm install
```

Restart the DSH app (or trigger a profile reload). DSH will pick up `dsh-toolcall-guard` as a
bundle and apply its `cordis.patch.yml`, which inserts the `toolcall-guard` row.

### Option B — write the row into the profile patch (module must already be resolvable)

`cordis.patch.yml` rows refer to a plugin **by module name**, so this option assumes
`dsh-toolcall-guard` can already be resolved from the profile's `node_modules` (for example after
`pnpm add dsh-toolcall-guard`, or after linking it as in Option A). If it cannot be resolved, use
Option A.

Append this block to `<profile>/cordis.patch.yml` and save (DSH's `patchReload: live` picks it up
without a restart):

```yaml
- insert:
    - id: toolcall-guard
      name: dsh-toolcall-guard
      config:
        enabled: true
        providerPattern: ''
        modelPattern: ''
        targetCode: EMPTY_RESPONSE
        maxScanChars: 200000
        rewriteWhenRealToolCallsPresent: false
        logOnly: false
        verbose: true
```

Do **not** declare the same `id` both as a bundle and as a patch row — that inserts it twice.

### Option C — npm

The package is not on the npm registry yet. If you want to publish your own fork:

```bash
npm publish   # from the repo root, after `npm login`
```

…then `pnpm add dsh-toolcall-guard` inside `<profile>` and add it to `dsh.profile.bundles` as in
Option A.

## Verify it is running

In DSH, list plugins and look for the row:

```
entryId: include:toolcall-guard    moduleName: dsh-toolcall-guard
enabled: true                      fiberPhase: active
```

If you have the Cordis inspect tools, `listConfigs` will also show `include:toolcall-guard`.
(A `status: absent` there is normal — this plugin has no user-facing Config schema; it is
configured entirely from its patch.)

## Configuration

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch |
| `providerPattern` | `''` | substring (case-insensitive) of the provider name; empty = all |
| `modelPattern` | `''` | substring of the model name; empty = all |
| `targetCode` | `'EMPTY_RESPONSE'` | failure code to raise; must be a retryable dsh-llm code |
| `maxScanChars` | `200000` | stop scanning after this many chars (0 = unlimited) |
| `rewriteWhenRealToolCallsPresent` | `false` | also rewrite turns that already have a real call |
| `logOnly` | `false` | log what would be rewritten, never rewrite |
| `verbose` | `true` | log every hit / pass-through |

Start with `logOnly: true` if you want to watch it for a few days before it starts enforcing.

## Token cost

The guard itself costs **zero tokens** — it is a local string scan over streamed chunks; it adds
no prompt text and no context. Only a genuinely malformed turn triggers a retry, and such a turn
produced nothing usable anyway, so the retry replaces waste rather than adding cost.

## Limitations

- It cannot *repair* a malformed turn; it can only discard and retry it. If an upstream model does
  this on every attempt, the retry policy will exhaust and the step fails — fix the model/route.
- It retries according to the provider's `retryPolicy`. If that policy does not list
  `EMPTY_RESPONSE` as retryable, the rewrite will surface as a normal `EMPTY_RESPONSE` error
  instead of being retried.
- Detection is heuristic. It targets the common tag shapes; an unusual dialect may slip through.
  `logOnly: true` + `verbose: true` is the way to discover a missed shape.

## Development

```bash
npm test        # node:test, 20 cases, no dependencies
```

## License

MIT © 2026 caly250
