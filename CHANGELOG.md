# Changelog

## 0.5.0

- **`<pi-debug id="…" />` now reports where the value came from**, the way a JavaScript console reports a
  variable: `target = "bench/rank_all.py"  (17 chars, from <pi-file pattern="bench/*.py" id="target">, stored
  13:35:55)`. The store keeps the whole spelling that produced the value, not just the tag name, plus a flag for
  ids the agent never named (shown as `(auto id)`).
- **The value cut is 50 characters, not 150** — the line now carries length, provenance and a timestamp, and the
  whole line has to survive being pasted into a shell command. `max="…"` widens it, `full="true"` removes the
  cut, `quiet="true"` prints only the value.
- Values are quoted and escaped (`\n` shown as an escape) instead of flattened with `⏎`.
- **Fix:** `part="source"` returned the value, not the provenance, because the provenance text itself starts with
  `<` and was being re-expanded as another reference. Provenance is now marked literal and never expanded.

## 0.4.0

- **`<pi-debug id="…" />`** prints what a variable actually holds, cut at 150 characters with `...`. The output
  is single-line (newlines shown as `⏎`) so it survives being pasted into a shell command; `max="600"` widens the
  cut, `full="true"` prints all of it, and `<pi-debug />` with no id dumps every variable with its source and its
  real length. An unknown id refuses and lists the ids that do exist.
- The guidance now lists `pi-debug`, and the built-in tag list in the selftest checks its spelling.

## 0.3.1

- **A tag inside a shell-quoted command now resolves.** Found by running a real session: the model wrote
  `echo "… <pi-ref type=\"url\" offset=\"-1\" />"` and the attributes parsed as empty, so the call was refused
  with `needs type=…`. Two spellings collide - `type=\"url\"` (the backslashes belong to the shell) and
  `pattern="issue (\d+)"` / `title="say \"hi\""` (a bare quote, escapes inside the value) - and no single regex
  tells them apart. Attribute values are read character by character now: a backslash before a quote closes a
  shell-quoted attribute, and elsewhere it escapes the quote into the value.

## 0.3.0

- **A tag's code is a file, not a string in JSON.** `~/.pi/agent/tags/<name>.js` with one default export;
  `"js": true` or `"js": "tools/shot.js"` points at it, and naming a tag in the config with no other kind finds
  `tags/<name>.js` on its own. Inline JavaScript bodies are gone - a body in JSON could not be linted, imported,
  or shared, and one tag per file can.
- **Every tag stores what it resolved to.** `id="target"` on any tag names the value, `<pi-var id="target" />`
  cites it again, `part="source"` says which tag produced it. Without an id the value is kept under a generated
  one and `<pi-vars />` lists them with their source. Named ids are never evicted; anonymous captures are the
  first dropped when the store fills (24 anonymous, 60 total) - before this a busy session filled the store with
  captures and then refused the agent's own variable.
- **`<pi-var>` uses `id`, not `name`**; the old attribute is refused with a message that says what to write.
- **`<pi-file />` returns paths relative to the working directory** (`bench/rank_all.py`), the way every other
  tool names a file, instead of relative to the directory the glob happened to start walking in.
- **Selftest.** 92 checks

## 0.2.0

The tags that stop the agent guessing things it should have read from the session.

- **`<pi-file pattern="bench/*.py" index="1" />`** resolves a glob to a file that really exists
  (`sort="recent|name"`, `absolute="true"`, `all="true"`), which is the largest family of failed `read`/`bash`
  calls: invented paths. Bounded walk (4000 files, depth 8, `node_modules`/`.git`/`dist` skipped).
- **`<pi-task />`** reads the project's background tasks from `.pi/tasks/<run>/<id>.json` and returns the id,
  name, status, command, output path, exit code, or age, filtered by `status=` and `match=`.
- **`<pi-tool index="2" />` and `<pi-tools match="web" />`** name tools the session actually has
  (`part="name|description"`, `scope="active|registered"`), instead of the ones the model remembers.
- **`<pi-repo part="root|branch|head|remote|dirty" />`** and **`<pi-session part="id|model|cwd|os|…" />`** —
  the repository and the session, read from git and from pi's own session manager.
- **`<pi-history pattern="eval_suite" />`** returns an earlier tool call's command; **`<pi-result
  pattern="prefill" context="240" />`** returns what an earlier call produced, as a window around the match
  (`full="true"`, `error="true"`, `part="tool"`).
- **`<pi-env name="HF_ENDPOINT" default="" />`** and **`<pi-skill name="…" file="…" />`** (extra roots via
  `skillRoots`).
- **`<pi-var name="mini" value="…" />` / `<pi-var name="mini" />`** — the agent names a thing once and reuses
  it. The stored text may itself contain tags, so a variable can hold a reference. `append=`, `unset=`,
  `persist="true"` (writes `.pi/pi-inline-vars.json`), `<pi-vars />` lists them, and `"vars"` in the config
  seeds them.
- **User tags now carry a `description`**, and the prompt injects one line per built-in in the exact form to
  write plus every user tag with its description, so the model learns the vocabulary instead of guessing it.
- **Removed: the `@` shorthand (`atSyntax`) and `<pi-ref type="tag">`** with its `u=` / `date=` / `name=`
  aliases. One grammar now: `<pi-… attr="…" />`. A hook function in the hooks file is callable as a tag
  (`due` in the file means `<pi-due modifier="+3d" />`).
- **Fix: tool calls were expanded without the session context**, so `cwd`, session id, model, history and
  results were unreachable from a tool argument.
- **Fix: an element may now sit inside an attribute value** (`value="<pi-ref type='url' />"`), because the
  scanner matches quoted runs before it excludes `>`.
- **Selftest.** 88 checks
## 0.1.0

- **Inline reference tags.** `<pi-ref type="url" offset="-1" />` resolves to the first URL in the most recent
  user message; `type="path"`, `type="line" index="3"`, and `type="text"` pick the path, a line, or the whole
  message. `offset` counts back from the newest (`-1`, `-2`) or names a message outright; `index` picks the
  entry inside that message.
- `<pi-date value="date|datetime|time|today|yesterday|tomorrow|week|year" offset="+3d|-2h|+10m|+1w" />` is
  computed at expansion time.
- **`format` on dates.** `<pi-date format="%Y-%m" />` renders any strftime shape (`%Y %m %d %F %T %H %M %S
  %j %V %u %w %a %A %b %B %Q %s %%`); an unknown `%` token is left as written. `ctx.date(kind, offset, format)`
  takes it too, and `<pi-ref type="date" format="..." />` accepts it.
- `type="number"` picks the standalone numbers in a message (`51`, `12.5` - not the `1` in `v1gate`), and
  `type="regex" pattern="..."` runs the user's own regular expression over it and returns the capture group,
  with `scope="session"` to search backwards through the whole conversation. An invalid pattern and a pattern
  that matches nothing are reported as different things. Every other tag name is declared by the user in `tags`,
  written with its bare name in config (`"pr"`) and with the prefix in text (`<pi-pr n="12" />`). The `pi-`
  prefix exists so a tag is never confused with an HTML element; the bare spelling still resolves too, and an
  undeclared name (`<whatever />`, `<div>`, `@scope/pkg`) is left alone.
- **Four tag shapes.** `value` (a literal), `template` with `{attr}` or `{1}` placeholders, `hook` (a function
  in the hooks file), and `js` — JavaScript written directly in the JSON, run with a `ctx` that carries
  `attrs`, `cwd`, `model`, `env()`, `now()`, `date()`, and `message(offset, type, index)`.
- **Your own syntax.** A tag may declare `pattern`, a regular expression of yours, so `[[ticket 42]]` can be a
  reference too. Capture groups become `{1}`, `{2}` in the template.
- **Expansion surfaces.** Tool arguments (before the tool runs), the model's finished messages (text blocks and
  tool-call arguments, rewritten in the transcript), and what you type. Each is toggled by
  `expandToolCalls` / `expandAssistant` / `expandUserInput`.
- **Unresolvable references refuse the call with the truth in the reason** — "message 9 points outside the
  conversation, this session has 2 user messages (offset="-1" is the most recent)", "tag `<pi-pr>` needs
  `n="…"`" — instead of letting the tool run on a wrong string.
- **promptHook.** A hook whose returned text is appended to the system prompt, so prompt text can be computed
  in JS rather than frozen in the config file.
- **Guidance with a model gate.** The tag rules plus a live index of the links and paths actually pasted
  (`<pi-ref type="url" offset="-1" /> = https://…`) and the user's own tags, injected only for the models in
  `models`.
- **JS hooks** in `<config dir>/pi-inline-tags.hooks.js` (override with `hooksFile`), with `hookTimeoutMs` and
  `hookCacheSeconds`; a hook that throws or returns nothing leaves the text alone rather than breaking the
  call. The hooks file may also declare `tags`.
- **Commands.** `/refs` lists every tag that resolves now and any config or hook problem;
  `/inline-tags status|on|off` shows the effective settings, whether the model gate matches the current model,
  and the last expansions applied.
- **Selftest.** 43 checks against a fake pi host and real temp files (`npm test`), covering each built-in,
  each tag shape, a throwing hook, a malformed index, `@scope/pkg` and HTML left alone, assistant message
  rewriting, user input expansion, the prompt hook, the model gate, `disableTags`, and config problem
  reporting.
