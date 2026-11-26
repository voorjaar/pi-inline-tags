# pi-inline-tags

**Let the agent name a fact it already has instead of retyping it from memory.**

A tag is an element the agent writes inside a tool call that the extension replaces, before the tool runs, with
the real thing from the session — a pasted URL, a path that exists on disk, a number a benchmark printed, a task
id — and a tag it cannot resolve refuses the call and names what does exist.

```
agent writes:  echo <pi-file pattern="src/**/login*" />
shell runs:    echo src/auth/login.ts

agent writes:  echo <pi-result pattern="passed" id="tests" />       # what a test run printed earlier
shell runs:    echo 212 passed in 4.8s

agent writes:  echo <pi-var id="tests" />                           # reuse it as often as you like
shell runs:    echo 212 passed in 4.8s
```

Weak models are the reason this exists. They type `src/auth/login.ts` when the file is `src/auth/login/index.ts`,
misremember the number from three tool calls ago, and kill a background task by an id they got wrong by one
character. A tag costs the agent nothing and cannot be wrong silently.

---

## The tags

| tag | what it reads | example |
| --- | --- | --- |
| `pi-ref` | a part of what the **user pasted** | `<pi-ref type="url" offset="-1" index="2" />` |
| `pi-date` | a computed date | `<pi-date value="date" offset="+3d" format="%Y-%m" />` |
| `pi-file` | a path that **exists on disk** | `<pi-file pattern="src/**/*.ts" index="1" all="true" />` |
| `pi-task` | a background task of this project | `<pi-task status="running" pattern="test" part="id\|command\|output\|exit\|age" all="true" />` |
| `pi-tool`, `pi-tools` | a tool this session really has | `<pi-tools pattern="web" />` |
| `pi-repo` | the git repository | `<pi-repo part="branch\|head\|remote\|dirty" />` |
| `pi-session` | this session | `<pi-session part="id\|model\|cwd\|os" />` |
| `pi-history` | a tool call the agent already made | `<pi-history pattern="docker build" />` |
| `pi-result` | what an earlier call **returned** | `<pi-result pattern="passed" id="tests" />` |
| `pi-env` | an environment variable | `<pi-env name="DATABASE_URL" default="postgres://localhost" />` |
| `pi-skill` | the path of an installed skill | `<pi-skill name="pdf-tools" file="scripts/render.py" />` |
| `pi-memory` | a project memory note, matched loosely | `<pi-memory name="why we chose postgres" />` |
| `pi-var` | a value the agent stored | `<pi-var id="prod" />` reads it, `<pi-var id="prod">ssh deploy@prod.example.com</pi-var>` writes it |
| `pi-debug` | what a stored value really is | `<pi-debug id="tests" />` |

`offset="-1"` is the most recent user message (`offset="7"` the seventh), `index` picks the entry inside it,
`index="1"` on `pi-result` / `pi-history` is the most recent match, `all="true"` lists every match.

### `pi-ref` types

`url` · `path` · `line` · `text` (the whole message) · `number` · `regex` (your own `pattern="issue (\d+)"`) ·
`date`. `scope="session"` searches the whole conversation instead of one message.

---

## Naming a thing once

Any tag that resolves is stored. Give it an id and cite it later:

```
<pi-file pattern="src/**/*.ts" index="1" id="target" />   →  src/auth/login.ts
<pi-var id="target" />                                    →  src/auth/login.ts   (as many times as you want)
```

Without an id the value is still kept under a generated one, and `<pi-debug />` lists everything with the tag
each came from.

**To keep what a command printed**, put the id on the reference — that is the only step:

```
npm test                                           # the call that produced the summary
echo <pi-result pattern="passed" id="tests" />     # freezes the text it resolved to
echo <pi-var id="tests" />                         # reuse it
```

**A variable's value is its body**: `<pi-var id="prod">ssh deploy@prod.example.com</pi-var>` writes it,
`<pi-var id="prod" />` reads it. `append="true"`, `unset="true"`, `part="source|length"` and `persist="true"`
(writes `.pi/pi-inline-vars.json`, so the next session starts with it) work on the body. Named ids are never
evicted; anonymous captures are dropped first.

**A body composes tags** — they resolve left to right, the literal text between them stays, and the whole span
is replaced once and stored:

```
<pi-var id="host">ssh deploy@prod.example.com</pi-var>
<pi-var id="dir">cd /srv/app</pi-var>
<pi-var id="deploy"><pi-var id="host" /> && <pi-var id="dir" /></pi-var>   →  ssh deploy@prod.example.com && cd /srv/app
<pi-var id="deploy" />                                                     # reuse it as often as you like
```

The parts do not have to be named first, which is what makes a body worth more than a list of ids:

```
<pi-var id="backup"><pi-file pattern="data/*.db" index="1" />-<pi-date value="date" /></pi-var>
→ data/app.db-2026-11-29
```

Two rules keep this from becoming a tree: **only `<pi-var>` and your own tags declared with `"children": true`
take a body**, and **bodies do not nest**. Ambiguous spellings are refused rather than guessed at —
`<pi-var id="x">text` (never closed), `</pi-var>` with no opening tag, and a body on a tag that takes none.

**`pi-debug`** prints a stored value the way a console prints a variable — value quoted, cut at 50 characters,
then its length, where it came from, and when:

```
tests = "212 passed in 4.8s"  (19 chars, from pi-result pattern="passed" id="tests", stored 13:43:40)
```

`max="600"` widens the cut, `full="true"` prints all of it, `quiet="true"` prints only the value, no `id` dumps
every variable (ids the agent never named are marked `(auto id)`).

**`pi-memory`** reads the notes a project keeps in `.memory/` (then `~/.pi/agent/memories/`):

```
<pi-memory name="why we chose postgres" />        →  row locks were the only thing that survived the write spike…
                                                  (matched "why-we-chose-postgres-over-mysql")
<pi-memory name="write spike" part="body" />      the note itself
<pi-memory all="true" />                          every note, with its type
```

Matching is loose on purpose — an agent remembers the shape of a title, not its 90-character slug — and the
answer names which note it picked.

---

## Your own tags

Names go in JSON, code goes in one file per tag. Write the name bare in config, use it with the `pi-` prefix:

```jsonc
{
  "tags": {
    "prod":   { "value": "ssh deploy@prod.example.com", "description": "the box deploys run on" },                      // a constant
    "pr":     { "template": "https://github.com/acme/app/pull/{n}", "attrs": ["n"], "description": "link to a pull request by number" },   // filled from attributes
    "ticket": { "pattern": "\\[\\[ticket\\s+(\\d+)\\]\\]", "template": "https://tracker.acme.dev/t/{1}", "description": "your own [[ticket 42]] syntax, expanded to its URL" }, // your own syntax
    "due":    { "js": true, "description": "the date the current task is due" },                                          // code in <config dir>/tags/due.js
    "shot":   { "hook": "shot", "attrs": ["days"], "description": "path to a screenshot taken N days ago" }              // code in your hooks file
  }
}
```

**Give every tag a `description`** — that sentence is what the agent is actually shown, in the injected guidance and
in `/tags`. A tag without one is a name the model does not know how to use, so it invents a shell command instead.
A `js` tag may carry `export const description = "…"` in its own file, which is used when the config has none.

| how | declared as | written | becomes |
| --- | --- | --- | --- |
| `value` | `{ "value": "ssh deploy@prod.example.com" }` | `<pi-prod />` | `ssh deploy@prod.example.com` |
| `template` | `{ "template": "…/pull/{n}", "attrs": ["n"] }` | `<pi-pr n="12" />` | `https://github.com/acme/app/pull/12` |
| `pattern` | `{ "pattern": "\\[\\[ticket\\s+(\\d+)\\]\\]", "template": "…/t/{1}" }` | `[[ticket 42]]` anywhere in the text | `https://tracker.acme.dev/t/42` — your own syntax, your own regex |
| `hook` | `{ "hook": "shot" }` | `<pi-shot days="2" />` | whatever `shot()` in your hooks file returns |
| `js` | `{ "js": true }` | `<pi-due />` | whatever the default export of `<config dir>/tags/due.js` returns |

`{n}` and `{1}` come from attributes or capture groups; a missing one refuses the call and names the attribute.
`disableTags` drops a built-in you do not want.

**A tag's code is a file** — one default export, found by the tag's own name. `"js": true` means
`<config dir>/tags/<name>.js` (then `<config dir>/<name>.js`), so `"due": { "js": true }` runs
`~/.pi/agent/tags/due.js`. A path (`"js": "tools/shot.js"`) resolves against the config directory, and naming a
tag with no other kind finds the script automatically.

```js
// ~/.pi/agent/tags/due.js   - the file "due": { "js": true } points at
export const description = "the date the task named in the last message is due";
export default (attrs, ctx) => {
  const days = Number(attrs.in ?? "7");
  return ctx.date("date", `+${days}d`);        // 2026-12-03
};
```

```js
// ~/.pi/agent/tags/sum.js
export const description = "adds two numbers passed as attributes";   // shows up in the guidance
export default (attrs, ctx) => String(Number(attrs.a) + Number(attrs.b));   // may be async
```

Declare `"children": true` and the tag may be written with a body; the function then receives `ctx.children`
(the resolved values, in order) and `ctx.body` (the body as written):

```json
{ "tags": { "table": { "js": "tools/table.js", "children": true, "description": "joins the values written inside it into one table row" } } }
```

```
<pi-table sep=" | "><pi-var id="file" /><pi-var id="lines" /></pi-table>   →   src/auth/login.ts | 148
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
  "tags": { "prod": { "value": "ssh deploy@prod.example.com", "description": "the deploy box" }, "due": { "js": true, "description": "the date the current task is due" } },
  "vars": { "staging": "staging.example.com" },
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

126 checks against a fake pi host and real temp files: every built-in (`ref` in all seven types, `date` with
`format`, `file`, `task`, `tool`/`tools`, `repo`, `session`, `history`, `result`, `env`, `skill` including a file
inside the skill, `var` with a composing body, `debug`, `memory` with fuzzy matching and `all`), every user tag
shape (`value`, `template`, `hook`, `script file`, `pattern`, `children`), a missing script file reported at load,
a throwing hook, malformed and out-of-range offsets, unclosed and unmatched bodies, retired tags and old attribute
names, a regex that matches nothing, an invalid pattern, `@scope/pkg` and HTML left alone, assistant message
rewriting, your own input being expanded, the prompt hook, the model gate, `disableTags`, and config problem
reporting.

## License

MIT — see [LICENSE](LICENSE).
