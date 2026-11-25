# pi-inline-tags

Let the agent **cite what you pasted** instead of re-typing it.

A model that copies a link, path, or id out of your message gets it wrong often enough to be its own failure
family: 404'd screenshot links, mangled ids, off-by-one paths. The correct string is already in the
conversation, so this extension remembers the conversation's own inputs and resolves a small inline tag to it.

A [pi](https://github.com/badlogic/pi-mono) coding-agent extension.

## The tags

```
<pi-ref type="url" offset="-1" />             first URL in the most recent message
<pi-ref type="url" offset="-1" index="2" />   its second URL
<pi-ref type="url" offset="7" />              first URL in message 7
<pi-ref type="path" offset="-1" />            its first path
<pi-ref type="line" offset="-1" index="3" />  its third non-empty line
<pi-ref type="text" offset="-1" />            the whole message, verbatim
<pi-ref type="number" offset="-1" />          the first number in it (index="2" the second)
<pi-ref type="regex" offset="-1" pattern="issue (\d+)" />  what your own regex captures
<pi-date value="date" offset="+3d" />        2026-11-29  (datetime, time, today, yesterday, tomorrow, week, year)
<pi-date format="%Y-%m" />                   any strftime shape: %Y %m %d %F %T %H %M %S %j %V %u %A %B %Q %s
<pi-pr n="12" />                             a tag you defined in JSON
```

**`offset` picks the message, `index` picks the entry inside it.** `offset` counts back from the newest
(`-1`, `-2`) or names a message outright, so the reference you write stays correct as the conversation grows;
`index` then means the second URL, the third line, the third number, the second regex match.

`type="number"` takes the numbers that stand on their own (`51`, `77`, `12.5`) - the `1` inside `v1gate` or
`a1b2c3.png` is not a number you would cite. `type="regex"` runs **your** regular expression over the message
and returns capture group 1 (or the whole match when there is none); `scope="session"` searches backwards
through the whole conversation instead of one message, and a pattern that is invalid or matches nothing refuses
the call and says which it was.

`pi-ref` and `pi-date` are the **only** built-in tags. The `pi-` prefix exists so a tag is never confused with
an HTML element — `<div>`, `<span>`, `@scope/package` and email addresses are never touched. The bare spelling
(`<ref type="url" />`) resolves too; an undeclared name (`<whatever />`) is left alone rather than guessed at.

Expansion happens in three places, so the real text — not the model's recollection of it — is what lands:

| where | what happens |
| --- | --- |
| tool arguments | every string in the call is expanded before the tool runs |
| the model's finished messages | text blocks and tool-call arguments are rewritten in the transcript |
| what you type | your own message is expanded before the agent sees it |

If a reference cannot be resolved in a tool call, the call is refused and the reason states what does exist:

```
A reference the call used could not be resolved: offset="9" points outside the conversation -
this session has 2 user messages (offset="-1" is the most recent). Fix the reference or write the text out in full.
```

## You define the tags, in JSON

Write the name bare in config, use it with the prefix in text:

```json
{
  "tags": {
    "host":   { "value": "ssh macminister.local" },
    "pr":     { "template": "https://github.com/voorjaar/v1gate/pull/{n}", "attrs": ["n"] },
    "shot":   { "hook": "screenshot", "attrs": ["days"] },
    "due":    { "js": "return ctx.date('date', '+3d')" },
    "ticket": { "pattern": "\\[\\[ticket\\s+(\\d+)\\]\\]", "template": "https://tracker.local/t/{1}" }
  }
}
```

| how | written | becomes |
| --- | --- | --- |
| `value` | `<pi-host />` | `ssh macminister.local` |
| `template` | `<pi-pr n="12" />` | `https://github.com/voorjaar/v1gate/pull/12` |
| `hook` | `<pi-shot days="2" />` | whatever your `screenshot()` returns |
| `js` | `<pi-due />` | the string your JavaScript in the JSON returns |
| `pattern` | `[[ticket 42]]` | `https://tracker.local/t/42` — your own syntax, your own regex |

`{n}` and `{1}` placeholders come from attributes or capture groups; a missing one refuses the call and names
the attribute it needs. `disableTags` drops a default tag you do not want.

### JavaScript in the config itself

A `js` tag is a function body, evaluated with a `ctx`:

```json
{ "tags": { "sum": { "js": "return String(Number(ctx.attrs.a) + Number(ctx.attrs.b))", "attrs": ["a", "b"] } } }
```

```js
ctx.name            // the tag name
ctx.attrs           // { a: "21", b: "21" } from the element
ctx.type, ctx.index, ctx.modifier, ctx.match
ctx.cwd, ctx.model, ctx.env("HOME"), ctx.now()
ctx.date("date", "+3d")            // a computed date
ctx.message("-2", "url", "1")      // a part of a pasted message (offset, type, index)
ctx.userMessages                   // how many there are
```

No `require`/`import` inside a `js` tag — the context carries what is useful, and the call is bounded by
`hookTimeoutMs`. Bigger code goes in the hooks file instead.

## JS hooks

Default file `<config dir>/pi-inline-tags.hooks.js` (override with `hooksFile`):

```js
export const host = () => "ssh macminister.local";
export const due = ({ modifier, attrs }) => shiftDueDate(modifier ?? attrs.days);
export async function screenshot({ attrs, cwd }) { return latestShot(attrs.days, cwd); }

// a hooks file may declare tags too
export const tags = { shot: { hook: "screenshot", attrs: ["days"] } };
```

A hook receives `{ name, attrs, modifier, model, cwd, userMessages }` and returns a string (sync or async).
Results are cached for `hookCacheSeconds`. A hook that throws or returns nothing leaves the text alone — it
never breaks a tool call.

### promptHook

`"promptHook": "morning_note"` appends whatever that hook returns to the system prompt, so your own prompt
text can be computed in JS rather than frozen in the config file.

## Configuration

`~/.pi/agent/pi-inline-tags.json` (point elsewhere with `PI_INLINE_TAGS_CONFIG`):

```json
{
  "enabled": true,
  "models": ["qwen3.8", "strata"],
  "refIndexSize": 6,
  "atSyntax": true,
  "expandToolCalls": true,
  "expandAssistant": true,
  "expandUserInput": true,
  "promptHook": "morning_note",
  "hooksFile": "~/.pi/agent/pi-inline-tags.hooks.js",
  "hookTimeoutMs": 2000,
  "hookCacheSeconds": 5,
  "disableTags": ["date"],
  "tags": { "host": { "value": "ssh macminister.local" } }
}
```

| key | meaning |
| --- | --- |
| `enabled` | master switch; `PI_INLINE_TAGS=off` overrides it |
| `models` | substrings matched against `provider/modelId` for the **guidance only**; empty means every model. Resolution always runs when enabled |
| `refIndexSize` | how many pasted links/paths to name in the prompt so the model knows which index to cite (0 disables) |
| `atSyntax` | also resolve the `@u7.url` / `@date+3d` / `@name` shorthand |
| `expandToolCalls` / `expandAssistant` / `expandUserInput` | which surfaces get expanded |
| `promptHook` | a hook whose returned text is appended to the system prompt |
| `hooksFile` | JS module for hooks and tags |
| `hookTimeoutMs`, `hookCacheSeconds` | per-call bound and how long a result is reused |
| `tags`, `disableTags` | your own tags; defaults to remove |

Guidance the extension injects (only for the models you list):

```
Use inline reference tags instead of retyping what the user pasted: <pi-ref type="url" offset="-1" /> is the first URL in the most recent message, …
References available now: <pi-ref type="url" offset="-1" /> = https://cdn.example.com/shots/a1b2c3.png · <pi-ref type="path" offset="-2" /> = /tmp/deep/dir/report.csv
Your own tags: <pi-pr n="…" /> → template https://github.com/voorjaar/v1gate/pull/{n} · <pi-host /> → value
```

## Commands

- `/refs` — every tag that resolves right now: the message range, the links and paths actually pasted, your
  own tags and hooks, the date forms, and any config or hook problem.
- `/inline-tags status|on|off` — effective settings, whether the model gate matches the current model, and the
  last expansions it applied.

## Install

```sh
pi install npm:pi-inline-tags
```

No build step: pi loads `index.ts` directly.

## What it deliberately does not do

- It never touches HTML it was not told about, `@scope/package`, or emails.
- It never invents a value for a tag it cannot resolve; it says what exists instead.
- It never runs a hook with unbounded time, and never lets a broken hook break a tool call.
- It rewrites text you or the model wrote; it never rewrites files or tool results.

## Development

```sh
git clone https://github.com/voorjaar/pi-inline-tags.git
cd pi-inline-tags
npm test          # node --experimental-strip-types selftest.mjs
```

43 checks against a fake pi host and real temp files: every built-in type (`url`, `path`, `line`, `text`,
`number`, `regex`, `date`, `tag`), every user tag shape (`value`, `template`, `hook`, `js`, `pattern`), a
throwing hook, a malformed and an out-of-range `offset`, a regex that matches nothing, an invalid pattern,
`@scope/pkg` and HTML left alone, the `@` shorthand and its switch, assistant message rewriting, your own input
being expanded, the prompt hook, the model gate, `disableTags`, and config problem reporting.

## License

MIT — see [LICENSE](LICENSE).
