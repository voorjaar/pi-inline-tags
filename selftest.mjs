// Standalone harness: fake pi host + real temp files, drives the real index.ts.
// Run: node --experimental-strip-types selftest.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

function makeSession(name, configBody, hooksSource, cwdOverride) {
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
  pi.getActiveTools = () => ["bash", "read", "edit", "fetch_content", "web_search"];
  pi.getAllTools = () => [
    { name: "bash", description: "Run a shell command" },
    { name: "read", description: "Read a file" },
    { name: "edit", description: "Edit a file with exact replacements" },
    { name: "fetch_content", description: "Fetch a URL or a local file" },
    { name: "web_search", description: "Search the web for sources" },
    { name: "sleep", description: "registered but not active in this session" },
  ];
  piInlineTags(pi);
  const entries = [];
  const ctx = {
    model: { provider: "strata", id: "qwen3.8-flash-next" },
    ui: { notify: (text) => notices.push(text) },
    cwd: cwdOverride ?? sandbox,
    sessionManager: {
      getSessionId: () => "01a203bb-c952-707e",
      getSessionName: () => "bench night",
      getSessionDir: () => join(sandbox, "sessions"),
      getEntries: () => entries,
    },
  };

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
  const record = (message) => entries.push({ type: "message", id: `e${entries.length}`, parentId: null, timestamp: new Date().toISOString(), message });
  return { commands, notices, ctx, call, userMessage, assistant, typed, record };
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

// One tag per script, under <config dir>/tags/.
mkdirSync(join(sandbox, "tags"), { recursive: true });
writeFileSync(join(sandbox, "tags", "due7.js"), "export default (attrs, ctx) => ctx.date('date', '+3d');\n");
writeFileSync(join(sandbox, "tags", "sum.js"), "export default (attrs) => String(Number(attrs.a) + Number(attrs.b));\n");
writeFileSync(join(sandbox, "tags", "lasturl.js"), "export default (attrs, ctx) => ctx.message('-2', 'url');\n");

const session = makeSession(
  "main.json",
  {
    tags: {
      host: { value: "ssh macminister.local" },
      pr: { template: "https://github.com/voorjaar/v1gate/pull/{n}", attrs: ["n"] },
      shot: { hook: "shot", attrs: ["days"] },
      due7: { js: true },
      sum: { js: "sum.js", attrs: ["a", "b"] },
      lasturl: { description: "the URL from two messages back" },
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
assert("tool arg: a tag whose code is a script file runs", !outcome.blocked && outcome.input.command === `echo ${inThreeDays}`, outcome.input.command);

outcome = await session.call("bash", { command: '<sum a="21" b="21" />' });
assert("tool arg: a script tag receives the element attributes", !outcome.blocked && outcome.input.command === "42", outcome.input.command);

outcome = await session.call("fetch_content", { url: "<lasturl />" });
assert("tool arg: a script tag can read the conversation through ctx.message", !outcome.blocked && outcome.input.url === "https://cdn.example.com/shots/a1b2c3.png", outcome.input.url);

outcome = await session.call("fetch_content", { url: "[[ticket 42]]" });
assert("tool arg: a user-defined pattern tag is matched and filled", !outcome.blocked && outcome.input.url === "https://tracker.local/t/42", outcome.input.url);

outcome = await session.call("bash", { command: 'echo <pi-due modifier="+3d" />' });
assert("tool arg: a JS hook from the hooks file returns the text", !outcome.blocked && outcome.input.command === "echo due:+3d", outcome.input.command);

outcome = await session.call("bash", { command: "echo <shot days=\"2\" />" });
assert("tool arg: an async hook receives the element attributes", !outcome.blocked && outcome.input.command === "echo shot:2", outcome.input.command);

outcome = await session.call("bash", { command: "echo <pi-boom />" });
assert("tool arg: a hook that throws leaves the text alone instead of breaking the call", !outcome.blocked && outcome.input.command === "echo <pi-boom />", outcome.input.command);

outcome = await session.call("bash", { command: 'npm i @sinclairzx81/typebox && echo <div class="x">hi</div>' });
assert("tool arg: @scope/pkg and real HTML are not touched", !outcome.blocked && outcome.input.command === 'npm i @sinclairzx81/typebox && echo <div class="x">hi</div>', outcome.input.command);

outcome = await session.call("fetch_content", { url: '<pi-ref type="url" offset="9" />' });
assert('tool arg: an out-of-range offset is refused with the real range', !!outcome.blocked && /points outside the conversation/.test(outcome.blocked.reason) && /2 user messages/.test(outcome.blocked.reason), outcome.blocked ? outcome.blocked.reason : "not blocked");

outcome = await session.call("fetch_content", { url: '<pi-ref type="url" offset="not-a-number" />' });
assert("tool arg: a malformed offset is refused with the shape it wants", !!outcome.blocked && /offset must be a message offset/.test(outcome.blocked.reason), outcome.blocked ? outcome.blocked.reason : "not blocked");

// --- no @ shorthand: only the element grammar ---------------------------------------------------------

outcome = await session.call("fetch_content", { url: "@u1.url" });
assert("@ is no longer a reference form - it stays exactly as written", !outcome.blocked && outcome.input.url === "@u1.url", outcome.input.url);

outcome = await session.call("fetch_content", { url: '<pi-ref type="tag" name="host" />' });
assert('type="tag" is gone: it is refused and says what to write instead', !!outcome.blocked && /type="tag"/.test(outcome.blocked.reason), outcome.blocked ? outcome.blocked.reason : "not blocked");

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

const bad = makeSession("bad.json", { tags: { broken: { js: "nope.js" } } });
await bad.userMessage("x");
await bad.commands.refs.handler("", bad.ctx);
assert("config: a tag whose script file is missing is reported, not silently dropped", bad.notices.some((note) => /does not point at a readable file/.test(note)), bad.notices.join("\n"));

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

// --- format: any strftime shape ---------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, "0");
const now = new Date();
const quarter = Math.floor(now.getMonth() / 3) + 1;
const inSevenDays = new Date(now.getTime() + 7 * 86_400_000);

outcome = await session.call("bash", { command: 'echo <pi-date format="%Y-%m" />' });
assert('tool arg: format="%Y-%m" renders year-month', !outcome.blocked && outcome.input.command === `echo ${now.getFullYear()}-${pad2(now.getMonth() + 1)}`, outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-date value="date" offset="+1w" format="%Y-%m-%d" />' });
assert('tool arg: format applies to an offset date too', !outcome.blocked && outcome.input.command === `echo ${inSevenDays.getFullYear()}-${pad2(inSevenDays.getMonth() + 1)}-${pad2(inSevenDays.getDate())}`, outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-ref type="date" format="%d.%m.%Y" />' });
assert('tool arg: <pi-ref type="date" format="..." /> takes the format as well', !outcome.blocked && outcome.input.command === `echo ${pad2(now.getDate())}.${pad2(now.getMonth() + 1)}.${now.getFullYear()}`, outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-date format="%Q %y" />' });
assert('tool arg: an unknown % token is left as written, a known one is filled', !outcome.blocked && outcome.input.command === `echo ${quarter} %y`, outcome.input.command);

const tomorrow = new Date(now.getTime() + 86_400_000);
writeFileSync(join(sandbox, "tags", "fmt.js"), 'export default (attrs, ctx) => ctx.date("date", "+1d", "%Y/%m/%d");\n');
const fmtTag = makeSession("fmt.json", { tags: { fmt: { js: true } } });
await fmtTag.userMessage("x");
const fmtOutcome = await fmtTag.call("bash", { command: "echo <pi-fmt />" });
assert("script tag: ctx.date(kind, offset, format) formats", !fmtOutcome.blocked && fmtOutcome.input.command === `echo ${tomorrow.getFullYear()}/${pad2(tomorrow.getMonth() + 1)}/${pad2(tomorrow.getDate())}`, fmtOutcome.input.command);

// --- the tags that stop the agent guessing ------------------------------------------------------------

mkdirSync(join(sandbox, "bench"), { recursive: true });
mkdirSync(join(sandbox, ".pi", "tasks", "run1"), { recursive: true });
writeFileSync(join(sandbox, "bench", "eval_suite.py"), "x");
writeFileSync(join(sandbox, "bench", "rank_all.py"), "x");
writeFileSync(join(sandbox, ".pi", "tasks", "run1", "b34b5bfff.json"), JSON.stringify({
  id: "b34b5bfff", name: "publish 0.6.3 to npm", command: "npm publish", status: "completed",
  startTime: Date.now() - 60_000, exitCode: 0, outputPath: ".pi/tasks/run1/b34b5bfff.output",
}));
writeFileSync(join(sandbox, ".pi", "tasks", "run1", "a11bbbb22.json"), JSON.stringify({
  id: "a11bbbb22", name: "mini hard suites", command: "sh run_mini_queue2.sh", status: "running",
  startTime: Date.now() - 5_000, exitCode: null, outputPath: ".pi/tasks/run1/a11bbbb22.output",
}));

outcome = await session.call("bash", { command: 'echo <pi-file pattern="bench/*.py" />' });
assert('tool arg: <pi-file pattern="bench/*.py" /> returns a file that really exists',
  !outcome.blocked && /^echo bench\/(eval_suite|rank_all)\.py$/.test(outcome.input.command), outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-file pattern="bench/*.py" absolute="true" />' });
assert('tool arg: absolute="true" gives the full path', !outcome.blocked && /^echo .+\/bench\/(eval_suite|rank_all)\.py$/.test(outcome.input.command), outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-file pattern="bench/*.{py,py}" all="true" />' });
assert('tool arg: all="true" lists every match', !outcome.blocked && outcome.input.command.includes("eval_suite.py") && outcome.input.command.includes("rank_all.py"), outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-file pattern="bench/*.nomatch" />' });
assert("tool arg: a glob that matches nothing says what it looked at", !!outcome.blocked && /no file matches pattern="bench\/\*\.nomatch"/.test(outcome.blocked.reason), outcome.blocked ? outcome.blocked.reason : "not blocked");

outcome = await session.call("bash", { command: "echo <pi-task status=\"running\" />" });
assert('tool arg: <pi-task status="running" /> gives the live task id', !outcome.blocked && outcome.input.command === "echo a11bbbb22", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-task match="publish" part="status" />' });
assert('tool arg: part="status" reads the task state', !outcome.blocked && outcome.input.command === "echo completed", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-task match="publish" part="output" />' });
assert('tool arg: part="output" gives the task output file', !outcome.blocked && outcome.input.command === "echo .pi/tasks/run1/b34b5bfff.output", outcome.input.command);

outcome = await session.call("bash", { command: "echo <pi-task index=\"9\" />" });
assert("tool arg: a task index that is out of range is refused", !!outcome.blocked && /index="9" resolves to nothing/.test(outcome.blocked.reason), outcome.blocked ? outcome.blocked.reason : "not blocked");

outcome = await session.call("bash", { command: 'echo <pi-tool index="2" />' });
assert('tool arg: <pi-tool index="2" /> names a tool the session actually has', !outcome.blocked && outcome.input.command === "echo read", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-tool part="description" match="shell" />' });
assert('tool arg: part="description" gives the tool description', !outcome.blocked && outcome.input.command === "echo Run a shell command", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-tool scope="registered" match="sleep" />' });
assert('tool arg: scope="registered" also sees tools not in the active set', !outcome.blocked && outcome.input.command === "echo sleep", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-tool match="never_used_tool_xyz" />' });
assert("tool arg: an invented tool name is refused with the real list", !!outcome.blocked && /no tool matches match="never_used_tool_xyz" in the active tool set/.test(outcome.blocked.reason), outcome.blocked ? outcome.blocked.reason : "not blocked");

outcome = await session.call("bash", { command: 'echo <pi-tools match="web" />' });
assert('tool arg: <pi-tools match="…" /> lists the matching tools', !outcome.blocked && /web_search/.test(outcome.input.command), outcome.input.command);

outcome = await session.call("bash", { command: "echo <pi-session />" });
assert('tool arg: <pi-session /> is this session id', !outcome.blocked && outcome.input.command === "echo 01a203bb-c952-707e", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-session part="model" />' });
assert('tool arg: part="model" is the model id, not a guess', !outcome.blocked && outcome.input.command === "echo qwen3.8-flash-next", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-session part="cwd" />' });
assert('tool arg: part="cwd" is the working directory the tools are using', !outcome.blocked && outcome.input.command === `echo ${sandbox}`, outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-session part="os" />' });
assert('tool arg: part="os" names the platform', !outcome.blocked && /^echo [a-z]+-[a-z0-9_]+$/.test(outcome.input.command), outcome.input.command);

const gitSession = makeSession("git.json", {}, undefined, process.cwd());
outcome = await gitSession.call("bash", { command: "echo <pi-repo />" });
assert('tool arg: <pi-repo /> is the repository root', !outcome.blocked && outcome.input.command === `echo ${process.cwd()}`, outcome.input.command);

outcome = await gitSession.call("bash", { command: 'echo <pi-repo part="branch" />' });
assert('tool arg: part="branch" is the branch name', !outcome.blocked && /^echo [A-Za-z0-9._/-]+$/.test(outcome.input.command), outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-repo part="head" />' });
assert("tool arg: outside a repository it says so instead of guessing", !!outcome.blocked && /not a git repository/.test(outcome.blocked.reason), outcome.blocked ? outcome.blocked.reason : "not blocked");

session.record({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "sh bench/eval_suite.py --model Mellum2.1-mlx-mxfp4" } }] });
session.record({ role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: "prefill 969.2 tok/s\ndecode 87.8 tok/s\nwrote results/mellum.speed.json" }] });
session.record({ role: "assistant", content: [{ type: "toolCall", id: "c2", name: "read", arguments: { path: "bench/rank_all.py" } }] });

outcome = await session.call("bash", { command: 'echo <pi-history pattern="eval_suite" />' });
assert('tool arg: <pi-history pattern="…" /> reuses an earlier command', !outcome.blocked && outcome.input.command === "echo sh bench/eval_suite.py --model Mellum2.1-mlx-mxfp4", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-history pattern="Mellum" part="tool" />' });
assert('tool arg: part="tool" names the tool that call used', !outcome.blocked && outcome.input.command === "echo bash", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-history pattern="never_ran" />' });
assert("tool arg: a history pattern with no match says how many calls it looked at", !!outcome.blocked && /looked at 2 calls in this session/.test(outcome.blocked.reason), outcome.blocked ? outcome.blocked.reason : "not blocked");

outcome = await session.call("bash", { command: 'echo <pi-result pattern="prefill" />' });
assert('tool arg: <pi-result pattern="…" /> pulls the text out of an earlier tool result', !outcome.blocked && outcome.input.command.includes("969.2"), outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-result pattern="decode" part="tool" />' });
assert('tool arg: <pi-result part="tool" /> says which tool produced it', !outcome.blocked && outcome.input.command === "echo bash", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-result pattern="nothing_like_this" />' });
assert("tool arg: a result pattern with no match says how many results it looked at", !!outcome.blocked && /looked at 1 result/.test(outcome.blocked.reason), outcome.blocked ? outcome.blocked.reason : "not blocked");

process.env.PI_INLINE_TEST_VALUE = "https://hf-mirror.com";
outcome = await session.call("bash", { command: 'echo <pi-env name="PI_INLINE_TEST_VALUE" />' });
assert('tool arg: <pi-env name="…" /> is the real environment value', !outcome.blocked && outcome.input.command === "echo https://hf-mirror.com", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-env name="PI_INLINE_NOT_SET" />' });
assert("tool arg: an unset variable is refused, not silently empty", !!outcome.blocked && /process.env.PI_INLINE_NOT_SET is not set/.test(outcome.blocked.reason), outcome.blocked ? outcome.blocked.reason : "not blocked");

outcome = await session.call("bash", { command: 'echo <pi-env name="PI_INLINE_NOT_SET" default="fallback" />' });
assert('tool arg: default="…" covers the unset case', !outcome.blocked && outcome.input.command === "echo fallback", outcome.input.command);

mkdirSync(join(sandbox, "skills", "selftest-skill-xyz"), { recursive: true });
writeFileSync(join(sandbox, "skills", "selftest-skill-xyz", "SKILL.md"), "# selftest");
const skillSession = makeSession("skill.json", { skillRoots: [join(sandbox, "skills")] });
outcome = await skillSession.call("read", { path: '<pi-skill name="selftest-skill-xyz" />' });
assert('tool arg: <pi-skill name="…" /> is the absolute SKILL.md path', !outcome.blocked && outcome.input.path === join(sandbox, "skills", "selftest-skill-xyz", "SKILL.md"), outcome.input.path);

outcome = await skillSession.call("read", { path: '<pi-skill name="not_installed" />' });
assert("tool arg: a skill that is not installed says where it looked", !!outcome.blocked && /no skill "not_installed" found/.test(outcome.blocked.reason), outcome.blocked ? outcome.blocked.reason : "not blocked");

// --- pi-var: the agent names a thing once and reuses it ---------------------------------------------

outcome = await session.call("bash", { command: 'echo <pi-var id="mini" value="ssh macminister.local" />' });
assert('tool arg: <pi-var name="mini" value="…" /> defines it', !outcome.blocked && outcome.input.command === "echo ssh macminister.local", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-var id="mini" /> <pi-var id="mini" /> -v' });
assert('tool arg: <pi-var id="mini" /> uses it as many times as you like', !outcome.blocked && outcome.input.command === "echo ssh macminister.local ssh macminister.local -v", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-var id="mini" value="--thinking off" append="true" />' });
assert('tool arg: append="true" adds a line to the variable', !outcome.blocked && outcome.input.command === "echo ssh macminister.local\n--thinking off", JSON.stringify(outcome.input.command));

outcome = await session.call("bash", { command: "echo <pi-var id=\"never_set\" />" });
assert("tool arg: using an undefined id lists the ones that exist", !!outcome.blocked && /no variable id="never_set" is defined - defined: mini/.test(outcome.blocked.reason), outcome.blocked ? outcome.blocked.reason : "not blocked");

outcome = await session.call("bash", { command: "echo <pi-var name=\"mini\" />" });
assert('tool arg: the old name="…" attribute is refused and points at id', !!outcome.blocked && /the attribute is id="…" now/.test(outcome.blocked.reason), outcome.blocked ? outcome.blocked.reason : "not blocked");

outcome = await session.call("bash", { command: 'echo <pi-file pattern="bench/*.py" id="target" /> and <pi-var id="target" />' });
assert('tool arg: any tag with id="…" stores its result for reuse', !outcome.blocked && /^echo bench\/(eval_suite|rank_all)\.py and bench\/(eval_suite|rank_all)\.py$/.test(outcome.input.command), outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-var id="target" part="source" />' });
assert('tool arg: part="source" says which tag produced the value', !outcome.blocked && outcome.input.command === "echo <pi-file>", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-task status="running" /> <pi-vars />' });
assert("tool arg: a tag with no id still gets one and shows up in <pi-vars />", !outcome.blocked && /from <pi-task>/.test(outcome.input.command), outcome.input.command.slice(0, 200));

outcome = await session.call("bash", { command: "echo <pi-vars />" });
assert("tool arg: <pi-vars /> lists what the agent has named", !outcome.blocked && /mini = ssh macminister/.test(outcome.input.command), outcome.input.command);

await session.userMessage("see https://example.com/shot.png");
outcome = await session.call("bash", { command: `echo <pi-var id="shot" value="<pi-ref type='url' offset='-1' />" />` });
assert('tool arg: a variable value may itself be a tag', !outcome.blocked && outcome.input.command === "echo https://example.com/shot.png", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-var id="shot" />' });
assert('tool arg: reading it back resolves the tag inside it again', !outcome.blocked && outcome.input.command === "echo https://example.com/shot.png", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-var id="shot" unset="true" />done' });
assert('tool arg: unset="true" removes it', !outcome.blocked && outcome.input.command === "echo done", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-var id="kept" value="persisted value" persist="true" />' });
assert('tool arg: persist="true" writes the variable to the project', !outcome.blocked && outcome.input.command === "echo persisted value", outcome.input.command);
assert('tool arg: the persisted variable is on disk under .pi/', existsSync(join(sandbox, ".pi", "pi-inline-vars.json")) && readFileSync(join(sandbox, ".pi", "pi-inline-vars.json"), "utf8").includes("kept"), readFileSync(join(sandbox, ".pi", "pi-inline-vars.json"), "utf8").slice(0, 120));

const seeded = makeSession("seeded.json", { vars: { box: "macminister.local" } });
outcome = await seeded.call("bash", { command: 'echo <pi-var id="box" />' });
assert('tool arg: vars in the config are available as <pi-var id="…" />', !outcome.blocked && outcome.input.command === "echo macminister.local", outcome.input.command);

// --- descriptions: the model is told what your tags mean ---------------------------------------------

const described = makeSession("described.json", {
  tags: { host: { value: "ssh macminister.local", description: "the mac mini every bench command runs on" } },
});
const guidance = await described.userMessage("run the suite");
assert("guidance: a user tag ships with its description so the model knows what it is for",
  guidance.some((line) => line.includes("<pi-host") && line.includes("the mac mini every bench command runs on")), guidance.join("\n").slice(0, 400));
assert("guidance: every built-in tag is listed with how to write it",
  ["<pi-ref type=", "<pi-date value=", "<pi-debug id=", "<pi-file pattern=", "<pi-task status=", "<pi-tool index=", "<pi-repo part=", "<pi-session part=", "<pi-history pattern=", "<pi-result pattern=", "<pi-env name=", "<pi-skill name="]
    .every((form) => guidance.some((line) => line.includes(form))), guidance.join("\n").slice(0, 900));

// --- pi-debug: what a variable actually holds, bounded so it survives being pasted into a command -------

const longValue = "x".repeat(200);
await session.call("bash", { command: `echo <pi-var id="long" value="${longValue}" />` });

outcome = await session.call("bash", { command: 'echo <pi-debug id="long" />' });
assert('tool arg: <pi-debug id="…" /> prints the value cut at 150 characters with "..."',
  !outcome.blocked && outcome.input.command === `echo ${"x".repeat(150)}...`, outcome.input.command.slice(0, 80));

await session.call("bash", { command: 'echo <pi-var id="short" value="mini.local" />' });
outcome = await session.call("bash", { command: 'echo <pi-debug id="short" />' });
assert("tool arg: a short value is printed whole, with no ellipsis",
  !outcome.blocked && outcome.input.command === "echo mini.local", outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-debug id="long" max="20" />' });
assert('tool arg: max="20" narrows the cut', !outcome.blocked && outcome.input.command === `echo ${"x".repeat(20)}...`, outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-debug id="long" full="true" />' });
assert('tool arg: full="true" prints all of it', !outcome.blocked && outcome.input.command === `echo ${longValue}`, outcome.input.command.slice(0, 60));

await session.call("bash", { command: 'echo <pi-var id="two" value="line one" />' });
await session.call("bash", { command: 'echo <pi-var id="two" value="line two" append="true" />' });
outcome = await session.call("bash", { command: 'echo <pi-debug id="two" />' });
assert("tool arg: a multi-line value stays on one line, newlines shown as ⏎",
  !outcome.blocked && /line one ⏎ line two/.test(outcome.input.command), outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-file pattern="bench/*.py" id="target" /> <pi-debug id="target" />' });
assert("tool arg: <pi-debug /> reads back anything another tag stored under an id",
  !outcome.blocked && /bench\/(eval_suite|rank_all)\.py bench\/(eval_suite|rank_all)\.py/.test(outcome.input.command), outcome.input.command);

outcome = await session.call("bash", { command: 'echo <pi-debug />' });
assert("tool arg: <pi-debug /> with no id dumps the variables with their source and length",
  !outcome.blocked && /long = x{150}\.\.\.  \(from pi-var, 200 chars\)/.test(outcome.input.command) && /target = /.test(outcome.input.command),
  outcome.input.command.slice(0, 200));

outcome = await session.call("bash", { command: 'echo <pi-debug id="nope" />' });
assert("tool arg: debugging an unknown id lists the ids that do exist",
  !!outcome.blocked && /no variable id="nope" is defined - defined: /.test(outcome.blocked.reason), outcome.blocked ? outcome.blocked.reason : "not blocked");

outcome = await session.call("bash", { command: 'echo <pi-debug id="short" max="abc" />' });
assert("tool arg: a non-numeric max is refused rather than guessed",
  !!outcome.blocked && /max="abc" is not a number of characters/.test(outcome.blocked.reason), outcome.blocked ? outcome.blocked.reason : "not blocked");

// A model that quotes its command writes the tag with shell escapes, which is how it really arrives.
outcome = await session.call("bash", { command: 'echo "the date is <pi-date value=\\"date\\" /> and the link <pi-ref type=\\"url\\" offset=\\"-1\\" />"' });
assert("tool arg: a tag inside a shell-quoted command (escaped quotes) still resolves",
  !outcome.blocked && /the date is \d{4}-\d{2}-\d{2} and the link https:\/\/\S+/.test(outcome.input.command),
  outcome.blocked ? outcome.blocked.reason : outcome.input.command);

console.log(`\n${failures === 0 ? "SELFTEST PASSED" : "SELFTEST FAILED"} (${failures} failing)`);
process.exit(failures === 0 ? 0 : 1);
