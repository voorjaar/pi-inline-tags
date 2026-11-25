# Changelog

## 0.1.0

- **Inline reference tags.** `<pi-ref type="url" index="-1" />` resolves to the first URL in the most recent
  user message; `type="path"`, `type="line" number="3"`, and `type="text"` pick the path, a line, or the whole
  message. `index` counts back from the newest (`-1`, `-2`) or names a message outright.
- `<pi-date value="date|datetime|time|today|yesterday|tomorrow|week|year" offset="+3d|-2h|+10m|+1w" />` is
  computed at expansion time.
- **`pi-ref` and `pi-date` are the only built-ins.** Every other tag name is declared by the user in `tags`,
  written with its bare name in config (`"pr"`) and with the prefix in text (`<pi-pr n="12" />`). The `pi-`
  prefix exists so a tag is never confused with an HTML element; the bare spelling still resolves too, and an
  undeclared name (`<whatever />`, `<div>`, `@scope/pkg`) is left alone.
- **Four tag shapes.** `value` (a literal), `template` with `{attr}` or `{1}` placeholders, `hook` (a function
  in the hooks file), and `js` — JavaScript written directly in the JSON, run with a `ctx` that carries
  `attrs`, `cwd`, `model`, `env()`, `now()`, `date()`, and `message(index, type, number)`.
- **Your own syntax.** A tag may declare `pattern`, a regular expression of yours, so `[[ticket 42]]` can be a
  reference too. Capture groups become `{1}`, `{2}` in the template.
- **Expansion surfaces.** Tool arguments (before the tool runs), the model's finished messages (text blocks and
  tool-call arguments, rewritten in the transcript), and what you type. Each is toggled by
  `expandToolCalls` / `expandAssistant` / `expandUserInput`.
- **Unresolvable references refuse the call with the truth in the reason** — "message 9 points outside the
  conversation, this session has 2 user messages (index="-1" is the most recent)", "tag `<pi-pr>` needs
  `n="…"`" — instead of letting the tool run on a wrong string.
- **promptHook.** A hook whose returned text is appended to the system prompt, so prompt text can be computed
  in JS rather than frozen in the config file.
- **Guidance with a model gate.** The tag rules plus a live index of the links and paths actually pasted
  (`<pi-ref type="url" index="-1" /> = https://…`) and the user's own tags, injected only for the models in
  `models`.
- **JS hooks** in `<config dir>/pi-inline-tags.hooks.js` (override with `hooksFile`), with `hookTimeoutMs` and
  `hookCacheSeconds`; a hook that throws or returns nothing leaves the text alone rather than breaking the
  call. The hooks file may also declare `tags`.
- **Commands.** `/refs` lists every tag that resolves now and any config or hook problem;
  `/inline-tags status|on|off` shows the effective settings, whether the model gate matches the current model,
  and the last expansions applied.
- **Selftest.** 26 checks against a fake pi host and real temp files (`npm test`), covering each built-in,
  each tag shape, a throwing hook, a malformed index, `@scope/pkg` and HTML left alone, assistant message
  rewriting, user input expansion, the prompt hook, the model gate, `disableTags`, and config problem
  reporting.
