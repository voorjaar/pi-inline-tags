# pi-inline-tags

**Let the agent name a fact it already has instead of retyping it from memory.**

A tag is an element the agent writes inside a tool call that the extension replaces, before the tool runs, with
the real thing from the session — a pasted URL, a path that exists on disk, a number a benchmark printed, a task
id — and a tag it cannot resolve refuses the call and names what does exist.

```
agent writes:  echo <pi-file pattern="bench/*rank*" />
shell runs:    echo bench/rank_all.py

agent writes:  echo <pi-result pattern="prefill" id="speed" />      # a result from earlier in this session
shell runs:    echo prefill 969.2 tok/s

agent writes:  echo <pi-var id="speed" />                           # reuse it as often as you like
shell runs:    echo prefill 969.2 tok/s
```

Weak models are the reason this exists. They invent file paths, misremember the number from three tool calls
ago, and kill a task id they got wrong by one character. A tag costs the agent nothing and cannot be wrong
silently.

---

## The tags

| tag | what it reads | example |
| --- | --- | --- |
| `pi-ref` | a part of what the **user pasted** | `<pi-ref type="url" offset="-1" index="2" />` |
| `pi-date` | a computed date | `<pi-date value="date" offset="+3d" format="%Y-%m" />` |
| `pi-file` | a path that **exists on disk** | `<pi-file pattern="bench/*.py" index="1" all="true" />` |
| `pi-task` | a background task of this project | `<pi-task status="running" pattern="bench" part="id\|command\|output\|age" />` |
| `pi-tool`, `pi-tools` | a tool this session really has | `<pi-tools pattern="web" />` |
| `pi-repo` | the git repository | `<pi-repo part="branch\|head\|remote\|dirty" />` |
| `pi-session` | this session | `<pi-session part="id\|model\|cwd\|os" />` |
| `pi-history` | a tool call the agent already made | `<pi-history pattern="eval_suite" />` |
| `pi-result` | what an earlier call **returned** | `<pi-result pattern="prefill" id="speed" />` |
| `pi-env` | an environment variable | `<pi-env name="HF_ENDPOINT" default="" />` |
| `pi-skill` | the path of an installed skill | `<pi-skill name="lilypond-music" file="scripts/x.py" />` |
| `pi-memory` | a project memory note, matched loosely | `<pi-memory name="bash suite axis" />` |
| `pi-var` | a value the agent stored | `<pi-var id="mini" />` reads it, `<pi-var id="mini">ssh host</pi-var>` writes it |
| `pi-debug` | what a stored value really is | `<pi-debug id="speed" />` |

`offset="-1"` is the most recent user message (`offset="7"` the seventh), `index` picks the entry inside it,
`index="1"` on `pi-result` / `pi-history` is the most recent match, `all="true"` lists every match.

### `pi-ref` types

`url` · `path` · `line` · `text` (the whole message) · `number` · `regex` (your own `pattern="issue (\d+)"`) ·
`date`. `scope="session"` searches the whole conversation instead of one message.

---

## Naming a thing once

Any tag that resolves is stored. Give it an id and cite it later:

```
<pi-file pattern="bench/*.py" id="target" />   →  bench/rank_all.py
<pi-var id="target" />                         →  bench/rank_all.py     (as many times as you want)
```

Without an id the value is still kept under a generated one, and `<pi-debug />` lists everything with the tag
each came from.

**To keep what a command printed**, put the id on the reference — that is the only step:

```
sh bench/drive_bench.py …                      # the call that produced the numbers
echo <pi-result pattern="prefill" id="speed" />   # freezes the text it resolved to
echo <pi-var id="speed" />                      # reuse it
```

**A variable's value is its body**: `<pi-var id="mini">ssh macminister.local</pi-var>` writes it,
`<pi-var id="mini" />` reads it. `append="true"`, `unset="true"`, `part="source|length"` and `persist="true"`
(writes `.pi/pi-inline-vars.json`, so the next session starts with it) work on the body. Named ids are never
evicted; anonymous captures are dropped first.

**A body composes tags** — they resolve left to right, the literal text between them stays, and the whole span
is replaced once and stored:

```
<pi-var id="host">ssh macminister.local</pi-var>
<pi-var id="dir">cd ~/bench</pi-var>
<pi-var id="run"><pi-var id="host" /> && <pi-var id="dir" /></pi-var>   →  ssh macminister.local && cd ~/bench
<pi-var id="run" />                                                     # reuse it as often as you like
```

The parts do not have to be named first, which is what makes a body worth more than a list of ids:

```
<pi-var id="adhoc"><pi-file pattern="bench/*.py" index="1" /> <pi-date value="date" /></pi-var>
→ bench/rank_all.py 2026-11-29
```

Two rules keep this from becoming a tree: **only `<pi-var>` and your own tags declared with `"children": true`
take a body**, and **bodies do not nest**. Ambiguous spellings are refused rather than guessed at —
`<pi-var id="x">text` (never closed), `</pi-var>` with no opening tag, and a body on a tag that takes none.

**`pi-debug`** prints a stored value the way a console prints a variable — value quoted, cut at 50 characters,
then its length, where it came from, and when:

```
speed = "prefill 969.2 tok…"  (69 chars, from pi-result pattern="prefill" id="speed", stored 13:43:40)
```

`max="600"` widens the cut, `full="true"` prints all of it, `quiet="true"` prints only the value, no `id` dumps
every variable (ids the agent never named are marked `(auto id)`).

**`pi-memory`** reads the notes a project keeps in `.memory/` (then `~/.pi/agent/memories/`):

```
<pi-memory name="bash suite axis" />        →  bash is the quality axis with the widest real spread…
                                               (matched "bash-suite-is-the-axis-that-actually-separates-workers")
<pi-memory name="never loaded" part="body" />   the note itself
<pi-memory all="true" />                      every note, with its type
```

Matching is loose on purpose — an agent remembers the shape of a title, not its 90-character slug — and the
answer names which note it picked.

---

## Your own tags

Names go in JSON, code goes in one file per tag. Write the name bare in config, use it with the `pi-` prefix:

```json
{
  "tags": {
    "host":   { "value": "ssh macminister.local", "description": "the mac mini every bench command runs on" },
    "pr":     { "template": "https://github.com/voorjaar/v1gate/pull/{n}", "attrs": ["n"] },
    "ticket": { "pattern": "\\[\\[ticket\\s+(\\d+)\\]\\]", "template": "https://tracker.local/t/{1}" },
    "due":    { "js": true },
    "shot":   { "js": "tools/shot.js", "attrs": ["days"] }
  }
}
```

| how | written | becomes |
| --- | --- | --- |
| `value` | `<pi-host />` | `ssh macminister.local` |
| `template` | `<pi-pr n="12" />` | `https://github.com/voorjaar/v1gate/pull/12` |
| `pattern` | `[[ticket 42]]` | `https://tracker.local/t/42` — your own syntax, your own regex |
| `hook` | `<pi-shot days="2" />` | whatever your `shot()` returns |
| `js` | `<pi-due />` | whatever the default export of `~/.pi/agent/tags/due.js` returns |

`{n}` and `{1}` come from attributes or capture groups; a missing one refuses the call and names the attribute.
`disableTags` drops a built-in you do not want.

**A tag's code is a file** — `~/.pi/agent/tags/<name>.js`, one default export. `"js": true` finds it by tag name,
a path (`"js": "tools/shot.js"`) resolves against the config directory, and naming a tag with no other kind finds
the script automatically.

```js
// ~/.pi/agent/tags/sum.js
export const description = "adds two numbers passed as attributes";   // shows up in the guidance
export default (attrs, ctx) => String(Number(attrs.a) + Number(attrs.b));   // may be async
```

Declare `"children": true` and the tag may be written with a body; the function then receives `ctx.children`
(the resolved values, in order) and `ctx.body` (the body as written):

```json
{ "tags": { "table": { "js": "tools/table.js", "children": true } } }
```

```
<pi-table sep=" | "><pi-var id="model" /><pi-var id="score" /></pi-table>   →   Mellum2.1 0.825 | Bolt 0.749
```

`ctx` carries what is useful: `attrs`, `type`, `index`, `modifier`, `match`, `cwd`, `model`, `env()`, `now()`,
`date("date", "+3d")`, `message("-2", "url", "1")`, `userMessages`.

Hooks live in `<config dir>/pi-inline-tags.hooks.js` (`export const due = ({ modifier }) => …`,
`export async function screenshot({ attrs }) { … }`), and `promptHook` adds one line to the agent's prompt.

---

## Where text gets expanded

| where | what happens |
| --- | --- |
| tool arguments | every string in the call is expanded before the tool runs |
| the model's finished messages | text blocks and tool-call arguments are rewritten in the transcript |
| what you type | your own message is expanded before the agent sees it |

A tag also works inside a quoted command — `echo "date <pi-date value=\"date\" />"` — because the shell's
escaped quotes are read as the attribute's delimiters, not as its value.

When a reference cannot be resolved, the call is refused and the reason states what does exist:

```
A reference the call used could not be resolved: offset="9" points outside the conversation -
this session has 2 user messages (offset="-1" is the most recent). Fix the reference or write the text out in full.
```

**Every built-in refuses loudly when it finds nothing, and the refusal names what does exist** — a guess is only
useful if a wrong one is visible. The `pi-` prefix exists so a tag is never confused with an HTML element:
`<div>`, `<span>`, `@scope/package` and email addresses are untouched. The bare spelling (`<ref type="url" />`)
resolves too; an undeclared name is left alone. Old spellings get a correction rather than silence:
`<pi-vars />` → *"is gone — `<pi-debug />` lists every variable"*, `match="…"` → *"write `pattern="…"`"*.

---

## Install

```sh
pi install npm:pi-inline-tags        # or a local checkout: pi install ./pi-inline-tags
```

Installed as a path package or in `~/.pi/agent/extensions/`; a session that was already open does not pick it up
until it is restarted (or `/reload` for auto-discovered extensions).

Config is optional — defaults apply to every model. `~/.pi/agent/pi-inline-tags.json`:

```json
{
  "enabled": true,
  "models": [],
  "disableTags": [],
  "tags": { "host": { "value": "ssh macminister.local", "description": "the mac mini" }, "due": { "js": true } },
  "vars": { "box": "macminister.local" },
  "skillRoots": [],
  "hooksFile": "~/.pi/agent/pi-inline-tags.hooks.js",
  "hookTimeoutMs": 2000
}
```

`models` gates the guidance injection (empty = every model). `/tags` lists the tags this session has and how to
write them.

## What it deliberately does not do

- **No execution.** A tag only ever reads. Running things stays with the shell, so one expansion cannot cause
  side effects before the preflight has refused the call.
- **No arithmetic, no control flow.** A tag body is the whole composition story on purpose, and it is one level deep.
- **No vault writes, no shell, no network.** It never edits a note, moves a file, or runs a command.
- **No silent fallback.** A reference that resolves to nothing stops the call.

## Development

```sh
git clone https://github.com/voorjaar/pi-inline-tags.git
cd pi-inline-tags
npm test          # node --experimental-strip-types selftest.mjs
```

121 checks against a fake pi host and real temp files: every built-in (`ref` in all seven types, `date` with
`format`, `file`, `task`, `tool`/`tools`, `repo`, `session`, `history`, `result`, `env`, `skill`, `var` with a
composing body, `debug`, `memory` with fuzzy matching and `all`), every user tag shape (`value`, `template`,
`hook`, `script file`, `pattern`, `children`), a missing script file reported at load, a throwing hook, malformed
and out-of-range offsets, retired tags and attributes, unclosed and unmatched bodies, a regex
that matches nothing, an invalid pattern, retired tags and old attribute names, `@scope/pkg` and HTML left alone,
assistant message rewriting, your own input being expanded, the prompt hook, the model gate, `disableTags`, and
config problem reporting.

## License

MIT — see [LICENSE](LICENSE).
