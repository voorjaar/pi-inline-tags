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
<pi-date value="date" offset="+3d" />         2026-11-29  (datetime, time, today, yesterday, tomorrow, week, year)
<pi-date format="%Y-%m" />                    any strftime shape: %Y %m %d %F %T %H %M %S %j %V %u %A %B %Q %s
```

What the session already knows, so the agent stops guessing it:

```
<pi-file pattern="bench/*.py" index="1" />                         a path that really exists (sort="recent|name", absolute="true", all="true")
<pi-task status="running" />                                      a background task id of this project
<pi-task match="bench" part="id|name|status|command|output|exit|age" />   which piece of it you want
<pi-tool index="2" />  <pi-tools match="web" />                   a tool this session actually has (part="name|description", scope="active|registered")
<pi-repo part="root|branch|head|remote|dirty" />                  the git repository, branch, HEAD
<pi-session part="id|name|model|provider|cwd|dir|file|os" />      this session id, model, working directory
<pi-history pattern="eval_suite" part="command|tool|args" />      an earlier tool call, so it is not retyped
<pi-result pattern="prefill" context="240" full="true" />         what an earlier tool call returned
<pi-env name="HF_ENDPOINT" default="" />                          an environment variable's value
<pi-skill name="lilypond-music" file="scripts/x.py" />            an installed skill's absolute path
<pi-var name="mini" value="ssh macminister.local" />              name a thing once…
<pi-var name="mini" />                                            …and use it as many times as you like
<pi-var name="mini" append="true" />  <pi-var name="mini" unset="true" />  add a line, remove it
<pi-vars />                                                       list what the agent named
<pi-debug id="mini" />                       inspect it: value cut at 50 chars + length + source tag
<pi-pr n="12" />                                                  a tag you defined in JSON
```

**`offset` picks the message, `index` picks the entry inside it.** `offset` counts back from the newest
(`-1`, `-2`) or names a message outright, so the reference you write stays correct as the conversation grows;
`index` then means the second URL, the third line, the third number, the second regex match.

`type="number"` takes the numbers that stand on their own (`51`, `77`, `12.5`) - the `1` inside `v1gate` or
`a1b2c3.png` is not a number you would cite. `type="regex"` runs **your** regular expression over the message
and returns capture group 1 (or the whole match when there is none); `scope="session"` searches backwards
through the whole conversation instead of one message, and a pattern that is invalid or matches nothing refuses
the call and says which it was.

**Every tag stores what it resolved to.** Give it an id and cite it later — `<pi-file pattern="bench/*.py"
id="target" />` then `<pi-var id="target" />`. Without an id the value is still kept under a generated one, and
`<pi-vars />` lists them with the tag each came from. `<pi-var id="mini" value="…" />` names one yourself;
`append="true"`, `unset="true"`, `part="source|length"`, and `persist="true"` (writes
`.pi/pi-inline-vars.json`, so the next session starts with it) work on any of them. Named ids are never
evicted; anonymous captures are the first to be dropped when the store fills.

**`pi-debug` is how you look at one**, in the shape a JavaScript console prints it:

```
mini = "ssh macminister.local"  (21 chars, from pi-var id="mini", stored 13:34:21)
target = "bench/rank_all.py"  (17 chars, from pi-file pattern="bench/*.py" id="target", stored 13:35:55)
```

The value is quoted and escaped (`\n` shown as an escape) and cut at 50 characters with `...`, because the line
also carries the length, the **tag and attributes that produced it**, and when it was stored — and the whole
line has to survive being pasted into a shell command. `max="600"` widens the cut, `full="true"` prints all of
it, `quiet="true"` prints only the value, and `<pi-debug />` with no id dumps every variable (an id the agent
never named is marked `(auto id)`). Debugging an unknown id refuses and lists the ids that do exist.

**Every built-in refuses loudly when it finds nothing, and the refusal names what does exist — a guess is only
useful if a wrong one is visible. The `pi-` prefix exists so a tag is never confused with
an HTML element — `<div>`, `<span>`, `@scope/package` and email addresses are never touched. The bare spelling
(`<ref type="url" />`) resolves too; an undeclared name (`<whatever />`) is left alone rather than guessed at.

A tag also works inside a quoted command — `echo "date <pi-date value=\"date\" />"` — because the shell's
escaped quotes are recognised as the attribute's delimiters, not as its value.

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
    "host":   { "value": "ssh macminister.local", "description": "the mac mini every bench command runs on" },
    "pr":     { "template": "https://github.com/voorjaar/v1gate/pull/{n}", "attrs": ["n"], "description": "a v1gate pull request" },
    "shot":   { "hook": "screenshot", "attrs": ["days"] },
    "due":    { "js": true },
    "shot":   { "js": "tools/shot.js" },
    "ticket": { "pattern": "\\[\\[ticket\\s+(\\d+)\\]\\]", "template": "https://tracker.local/t/{1}" }
  }
}
```

| how | written | becomes |
| --- | --- | --- |
| `value` | `<pi-host />` | `ssh macminister.local` |
| `template` | `<pi-pr n="12" />` | `https://github.com/voorjaar/v1gate/pull/12` |
| `hook` | `<pi-shot days="2" />` | whatever your `screenshot()` returns |
| `js` | `<pi-due />` | whatever the `default` export of `~/.pi/agent/tags/due.js` returns |
| `pattern` | `[[ticket 42]]` | `https://tracker.local/t/42` — your own syntax, your own regex |

`{n}` and `{1}` placeholders come from attributes or capture groups; a missing one refuses the call and names
the attribute it needs. `disableTags` drops a default tag you do not want.

### A tag's code is a file: `~/.pi/agent/tags/<name>.js`

One tag per script, one default export. `"js": true` picks `tags/<name>.js`; a path (`"js":
"tools/shot.js"`) resolves against the config directory or the tags directory. Naming a tag in the config with
no `value`/`template`/`hook`/`js` also finds `tags/<name>.js` automatically. Inline JavaScript bodies in the
JSON are gone.

```js
// ~/.pi/agent/tags/sum.js
export const description = "adds two numbers you pass as attributes";
export default (attrs, ctx) => String(Number(attrs.a) + Number(attrs.b));   // may be async
```

`ctx` is the same context everywhere:

```js
ctx.name            // the tag name
ctx.attrs           // { a: "21", b: "21" } from the element
ctx.type, ctx.index, ctx.modifier, ctx.match
ctx.cwd, ctx.model, ctx.env("HOME"), ctx.now()
ctx.date("date", "+3d")            // a computed date
ctx.message("-2", "url", "1")      // a part of a pasted message (offset, type, index)
ctx.userMessages                   // how many there are
```

A script may export `description` and `attrs` too, and they show up in the guidance. The call is bounded by
`hookTimeoutMs`, and a script that returns nothing leaves the text as written.

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
  "expandToolCalls": true,
  "expandAssistant": true,
  "expandUserInput": true,
  "promptHook": "morning_note",
  "hooksFile": "~/.pi/agent/pi-inline-tags.hooks.js",
  "hookTimeoutMs": 2000,
  "hookCacheSeconds": 5,
  "disableTags": ["date"],
  "skillRoots": ["~/my-skills"],
  "vars": { "box": "macminister.local" },
  "tags": {
    "host": { "value": "ssh macminister.local", "description": "the mac mini every bench command runs on" },
    "due":  { "js": true }
  }
}
```

| key | meaning |
| --- | --- |
| `enabled` | master switch; `PI_INLINE_TAGS=off` overrides it |
| `models` | substrings matched against `provider/modelId` for the **guidance only**; empty means every model. Resolution always runs when enabled |
| `refIndexSize` | how many pasted links/paths to name in the prompt so the model knows which index to cite (0 disables) |
| `expandToolCalls` / `expandAssistant` / `expandUserInput` | which surfaces get expanded |
| `promptHook` | a hook whose returned text is appended to the system prompt |
| `hooksFile` | JS module for hooks and tags |
| `hookTimeoutMs`, `hookCacheSeconds` | per-call bound and how long a result is reused |
| `tags`, `disableTags` | your own tags; defaults to remove. A tag's `description` is shown to the model |
| `skillRoots` | extra directories `<pi-skill />` searches (after these: `<cwd>/.pi/skills`, `~/.pi/agent/skills`, `~/.agents/skills`, `~/.claude/skills`) |
| `vars` | variables that start defined, so `<pi-var name="box" />` resolves from the first message |

Guidance the extension injects (only for the models you list): one line per built-in in the exact form to
write, then the links and paths actually pasted in this session, then your own tags with their descriptions:

```
Inline tags resolve to real text at the moment the call runs - use them instead of retyping URLs, paths, task ids, tool names, or dates you have already seen.
<pi-ref type="url|path|line|text|number|regex|date" offset="-1" index="2" pattern="…" format="%Y-%m" scope="session" /> - a part of what the user pasted (offset picks the message, index the entry inside it)
<pi-file pattern="bench/*.py" index="1" sort="recent|name" absolute="true" all="true" /> - a path that really exists on disk instead of one you invented
<pi-task status="running" match="bench" part="id|name|status|command|output|exit|age" all="true" /> - a background task of this project
References available now: <pi-ref type="url" offset="-1" /> = https://cdn.example.com/shots/a1b2c3.png · <pi-ref type="path" offset="-2" /> = /tmp/deep/dir/report.csv
the mac mini every bench command runs on - <pi-host /> (fixed text: ssh macminister.local) · a v1gate pull request - <pi-pr n="…" /> (template https://github.com/voorjaar/v1gate/pull/{n})
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

103 checks against a fake pi host and real temp files: every built-in (`ref` in all seven types, `date` with
`format`, `file`, `task`, `tool`/`tools`, `repo`, `session`, `history`, `result`, `env`, `skill`,
`var`/`vars`/`debug` including a value that contains a tag, an id captured from another tag, the 150-character
debug cut with `max`/`full`, and `persist` writing to `.pi/`), every user tag shape (`value`, `template`, `hook`, `js` script file, `pattern`), a missing script file
reported at load, a throwing hook, a malformed and an out-of-range `offset`, a regex that matches nothing, an
invalid pattern, `@scope/pkg` and HTML left alone, assistant message rewriting, your own input being expanded,
the prompt hook, the model gate, `disableTags`, guidance carrying every tag and its description, and config
problem reporting.

## License

MIT — see [LICENSE](LICENSE).
