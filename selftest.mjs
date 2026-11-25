// Standalone harness: fake pi host + real temp files, drives the real index.ts.
// Run: node --experimental-strip-types selftest.mjs
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piInlineTags from "./index.ts";

const sandbox = mkdtempSync(join(tmpdir(), "inline-tags-"));
let failures = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
}

function makeSession(name, configBody, hooksSource) {
  const configPath = join(sandbox, name);
  writeFileSync(configPath, JSON.stringify(configBody));
  if (hooksSource !== undefined) writeFileSync(join(sandbox, "pi-inline-tags.hooks.js"), hooksSource);
  process.env.PI_INLINE_TAGS_CONFIG = configPath;

  const handlers = { before_agent_start: [], tool_call: [], message_end: [], input: [] };
  const commands = {};
  const notices = [];
  const pi = {
    on(name, fn) {
      if (!handlers[name]) handlers[name] = [];
      handlers[name].push(fn);
    },
    registerCommand(name, def) {
      commands[name] = def;
    },
  };
  piInlineTags(pi);
  const ctx = { model: { provider: "strata", id: "qwen3.8-flash-next" }, ui: { notify: (text) => notices.push(text) } };

  const call = async (toolName, input) => {
    let blocked;
    for (const fn of handlers.tool_call) {
      const outcome = await fn({ toolName, input }, ctx);
      if (outcome && outcome.block) blocked = outcome;
    }
    return { blocked, input };
  };
  const userMessage = async (prompt, selectedTools = ["fetch_content", "bash"]) => {
    const event = { messageType: "user", prompt, systemPromptOptions: { promptGuidelines: [], selectedTools } };
    for (const fn of handlers.before_agent_start) await fn(event, ctx);
    return event.systemPromptOptions.promptGuidelines ?? [];
  };
  const assistant = async (blocks) => {
    let replacement;
    for (const fn of handlers.message_end) {
      const outcome = await fn({ message: { role: "assistant", content: blocks } }, ctx);
      if (outcome?.message) replacement = outcome.message;
    }
    return replacement;
  };
  const typed = async (text) => {
    let outcome;
    for (const fn of handlers.input) {
      const result = await fn({ text, images: undefined }, ctx);
      if (result) outcome = result;
    }
    return outcome;
  };
  return { commands, notices, ctx, call, userMessage, assistant, typed };
}

const hooksSource = `
export const due = ({ modifier }) => \`due:\${modifier ?? "none"}\`;
export async function shot({ attrs }) { return \`shot:\${attrs.days ?? "0"}\`; }
export function boom() { throw new Error("hook exploded"); }
`;

const probe = new Date();
probe.setDate(probe.getDate() + 3);
const pad = (value) => String(value).padStart(2, "0");
const inThreeDays = `${probe.getFullYear()}-${pad(probe.getMonth() + 1)}-${pad(probe.getDate())}`;

const session = makeSession(
  "main.json",
  {
    tags: {
      host: { value: "ssh macminister.local" },
      pr: { template: "https://github.com/voorjaar/v1gate/pull/{n}", attrs: ["n"] },
      shot: { hook: "shot", attrs: ["days"] },
      due7: { js: "return ctx.date('date', '+3d')" },
      sum: { js: "return String(Number(ctx.attrs.a) + Number(ctx.attrs.b))", attrs: ["a", "b"] },
      lasturl: { js: "return ctx.message('-2', 'url')" },
      ticket: { pattern: "\\[\\[ticket\\s+(\\d+)\\]\\]", template: "https://tracker.local/t/{1}" },
    },
    promptHook: "due",
  },
  hooksSource,
);

// --- user messages feed the references -------------------------------------------------------------

const first = await session.userMessage("look at this screenshot https://cdn.example.com/shots/a1b2c3.png please");
assert(
  "guidance: the pasted link is named as a tag the model can cite",
  first.some((line) => line.includes('<pi-ref type="url" offset="-1" /> = https://cdn.example.com/shots/a1b2c3.png')),
  first.join("\n"),
);
await session.userMessage("/tmp/deep/dir/report.csv\nsecond line here\nthird line here");

// --- the canonical grammar in tool arguments ---------------------------------------------------------

let outcome = await session.call("fetch_content", { url: '<pi-ref type="url" offset="-2" />' });
assert('tool arg: <pi-ref type="url" offset="-2" /> is the URL from the message before the last', !outcome.blocked && outcome.input.url === "https://cdn.example.com/shots/a1b2c3.png", outcome.input.url);

outcome = await session.call("bash", { command: "wc -l <pi-ref type=\"path\" offset=\"-1\" />" });
assert('tool arg: <pi-ref type="path" offset="-1" /> resolves to the path in the newest message', !outcome.blocked && outcome.input.command === "wc -l /tmp/deep/dir/report.csv", outcome.input.command);

outcome = await session.call("bash", { command: "echo <pi-ref type=\"line\" offset=\"-1\" index=\"3\" />" });
assert('tool arg: <pi-ref type="line" index="3" /> picks that line', !outcome.blocked && outcome.input.command === "echo third line here", outcome.input.command);

outcome = await session.call("bash", { command: "echo <pi-ref type=\"url\" offset=\"-2\" index=\"2\" />" });
assert('tool arg: a URL with no second entry is refused with what the message has', !!outcome.blocked && /has 1 URL/.test(outcome.blocked.reason), outcome.blocked ? outcome.blocked.reason : "not blocked");

outcome = await session.call("bash", { command: 'echo <pi-date value="date" offset="+3d" />' });
assert('tool arg: <date offset="+3d" /> is computed', !outcome.blocked && outcome.input.command === `echo ${inThreeDays}`, outcome.input.command);

outcome = await session.call("bash", { command: "echo <pi-ref type=\"date\" value=\"date\" offset=\"+3d\" />" });
assert("tool arg: the same date through <pi-ref type=\"date\">", !outcome.blocked && outcome.input.command === `echo ${inThreeDays}`, outcome.input.command);

// --- tags the user defined in JSON -------------------------------------------------------------------

outcome = await session.call("bash", { command: "echo <host />" });
assert("tool arg: a value tag is substituted", !outcome.blocked && outcome.input.command === "echo ssh macminister.local", outcome.input.command);

outcome = await session.call("fetch_content", { url: '<pr n="12" />' });
assert("tool arg: a template tag fills its placeholder", !outcome.blocked && outcome.input.url === "https://github.com/voorjaar/v1gate/pull/12", outcome.input.url);

outcome = await session.call("fetch_content", { url: "<pr />" });
assert("tool arg: a template tag missing its attribute is refused with what it needs", !!outcome.blocked && /needs n=/.test(outcome.blocked.reason), outcome.blocked ? outcome.blocked.reason : "not blocked");

outcome = await session.call("bash", { command: "echo <due7 />" });
assert("tool arg: a js tag defined in JSON runs and returns text", !outcome.blocked && outcome.input.command === `echo ${inThreeDays}`, outcome.input.command);

outcome = await session.call("bash", { command: '<sum a="21" b="21" />' });
assert("tool arg: a js tag receives the element attributes", !outcome.blocked && outcome.input.command === "42", outcome.input.command);

outcome = await session.call("fetch_content", { url: "<lasturl />" });
assert("tool arg: a js tag can read the conversation through ctx.message", !outcome.blocked && outcome.input.url === "https://cdn.example.com/shots/a1b2c3.png", outcome.input.url);

outcome = await session.call("fetch_content", { url: "[[ticket 42]]" });
assert("tool arg: a user-defined pattern tag is matched and filled", !outcome.blocked && outcome.input.url === "https://tracker.local/t/42", outcome.input.url);

outcome = await session.call("bash", { command: 'echo <pi-ref type="tag" name="due" modifier="+3d" />' });
assert("tool arg: a JS hook from the hooks file returns the text", !outcome.blocked && outcome.input.command === "echo due:+3d", outcome.input.command);

outcome = await session.call("bash", { command: "echo <shot days=\"2\" />" });
assert("tool arg: an async hook receives the element attributes", !outcome.blocked && outcome.input.command === "echo shot:2", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-ref type="tag" name="boom" />' });
assert("tool arg: a hook that throws leaves the text alone instead of breaking the call", !outcome.blocked && outcome.input.command === 'echo <pi-ref type="tag" name="boom" />', outcome.input.command);

outcome = await session.call("bash", { command: 'npm i @sinclairzx81/typebox && echo <div class="x">hi</div>' });
assert("tool arg: @scope/pkg and real HTML are not touched", !outcome.blocked && outcome.input.command === 'npm i @sinclairzx81/typebox && echo <div class="x">hi</div>', outcome.input.command);

outcome = await session.call("fetch_content", { url: '<pi-ref type="url" offset="9" />' });
assert('tool arg: an out-of-range offset is refused with the real range', !!outcome.blocked && /points outside the conversation/.test(outcome.blocked.reason) && /2 user messages/.test(outcome.blocked.reason), outcome.blocked ? outcome.blocked.reason : "not blocked");

outcome = await session.call("fetch_content", { url: '<pi-ref type="url" offset="not-a-number" />' });
assert("tool arg: a malformed offset is refused with the shape it wants", !!outcome.blocked && /offset must be a message offset/.test(outcome.blocked.reason), outcome.blocked ? outcome.blocked.reason : "not blocked");

// --- aliases and the @ shorthand ----------------------------------------------------------------------

outcome = await session.call("fetch_content", { url: '<ref u="1.url" />' });
assert('alias: <ref u="1.url" /> still resolves', !outcome.blocked && outcome.input.url === "https://cdn.example.com/shots/a1b2c3.png", outcome.input.url);

outcome = await session.call("fetch_content", { url: "@u1.url" });
assert("@ shorthand: @u1.url still resolves", !outcome.blocked && outcome.input.url === "https://cdn.example.com/shots/a1b2c3.png", outcome.input.url);

const noAt = makeSession("noat.json", { atSyntax: false });
await noAt.userMessage("link https://example.com/a");
outcome = await noAt.call("fetch_content", { url: "@u1.url" });
assert("@ shorthand: atSyntax=false turns only the shorthand off", !outcome.blocked && outcome.input.url === "@u1.url", outcome.input.url);

// --- the model's own messages and what you type -----------------------------------------------------

const replaced = await session.assistant([
  { type: "text", text: "I fetched <pi-ref type=\"url\" offset=\"-2\" /> and saved it." },
  { type: "toolCall", name: "read", arguments: { path: '<pi-ref type="path" offset="-1" />' } },
]);
assert(
  "assistant message: the stored text and tool args carry the real strings",
  !!replaced && replaced.content[0].text === "I fetched https://cdn.example.com/shots/a1b2c3.png and saved it." && replaced.content[1].arguments.path === "/tmp/deep/dir/report.csv",
  JSON.stringify(replaced),
);

const transformed = await session.typed('open <pi-ref type="url" offset="-2" /> today');
assert("user input: what you type is expanded too", transformed?.action === "transform" && transformed.text === "open https://cdn.example.com/shots/a1b2c3.png today", JSON.stringify(transformed));

// --- prompt hook, tag summaries, gate, and config reporting ------------------------------------------

assert(
  "promptHook: a hook's text is appended to the system prompt",
  first.some((line) => line.includes("User prompt hook due: due:")),
  first.join("\n"),
);
assert(
  "guidance: your own tags are listed with their shape",
  first.some((line) => line.includes("Your own tags:") && line.includes("<pi-pr")),
  first.join("\n"),
);

const gated = makeSession("gated.json", { models: ["llama-cpp"] });
assert("model gate: unlisted models do not get the guidance", (await gated.userMessage("https://example.com/x")).length === 0);

const bad = makeSession("bad.json", { tags: { broken: { js: "return (" } } });
await bad.userMessage("x");
await bad.commands.refs.handler("", bad.ctx);
assert("config: a tag whose js does not parse is reported, not silently dropped", bad.notices.some((note) => /not valid JavaScript/.test(note)), bad.notices.join("\n"));

const disabled = makeSession("off.json", { enabled: false });
await disabled.userMessage("https://example.com/y");
outcome = await disabled.call("fetch_content", { url: '<pi-ref type="url" offset="-1" />' });
assert("config: enabled=false turns expansion off", !outcome.blocked && outcome.input.url === '<pi-ref type="url" offset="-1" />', outcome.input.url);

const trimmed = makeSession("trim.json", { disableTags: ["date"] });
await trimmed.userMessage("x");
outcome = await trimmed.call("bash", { command: "echo <pi-date />" });
assert("config: disableTags removes a default tag", !outcome.blocked && outcome.input.command === "echo <pi-date />", outcome.input.command);

const unknown = makeSession("plain.json", {});
await unknown.userMessage("x");
outcome = await unknown.call("bash", { command: "echo <whatever />" });
assert("an undeclared tag name is left alone, not guessed at", !outcome.blocked && outcome.input.command === "echo <whatever />", outcome.input.command);

// --- numbers and your own regex ---------------------------------------------------------------------

await session.userMessage("fix v1gate issue 51 and issue 77, memory budget 12.5 GB");

outcome = await session.call("bash", { command: 'echo <pi-ref type="number" offset="-1" />' });
assert('tool arg: <pi-ref type="number" /> picks the first number in that message', !outcome.blocked && outcome.input.command === "echo 51", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-ref type="number" offset="-1" index="3" />' });
assert('tool arg: <pi-ref type="number" index="3" /> picks the third, decimals included', !outcome.blocked && outcome.input.command === "echo 12.5", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-ref type="number" offset="-1" index="9" />' });
assert("tool arg: a number that is not there is refused with how many were found", !!outcome.blocked && /no 9th number in message 3/.test(outcome.blocked.reason), outcome.blocked ? outcome.blocked.reason : "not blocked");

outcome = await session.call("bash", { command: 'echo <pi-ref type="regex" offset="-1" pattern="issue (\\d+)" />' });
assert('tool arg: <pi-ref type="regex" /> returns the capture group', !outcome.blocked && outcome.input.command === "echo 51", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-ref type="regex" offset="-1" index="2" pattern="issue (\\d+)" />' });
assert('tool arg: index picks the second regex match', !outcome.blocked && outcome.input.command === "echo 77", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-ref type="regex" scope="session" pattern="(\\d+\\.\\d+) GB" />' });
assert('tool arg: scope="session" searches back through the conversation', !outcome.blocked && outcome.input.command === "echo 12.5", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-ref type="regex" offset="-1" pattern="gate#(\\d+)" />' });
assert("tool arg: a regex that matches nothing says so", !!outcome.blocked && /matched nothing in message 3/.test(outcome.blocked.reason), outcome.blocked ? outcome.blocked.reason : "not blocked");

outcome = await session.call("bash", { command: 'echo <pi-ref type="regex" offset="-1" pattern="([\\d+" />' });
assert("tool arg: an invalid pattern is refused as invalid", !!outcome.blocked && /not a valid regular expression/.test(outcome.blocked.reason), outcome.blocked ? outcome.blocked.reason : "not blocked");

console.log(`\n${failures === 0 ? "SELFTEST PASSED" : "SELFTEST FAILED"} (${failures} failing)`);
process.exit(failures === 0 ? 0 : 1);
