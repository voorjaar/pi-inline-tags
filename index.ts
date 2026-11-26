/**
 * pi-inline-tags - let the agent cite what you pasted instead of retyping it.
 *
 * Why this exists: a model that re-types a link, path, or id the human pasted gets it wrong often enough to
 * be its own failure family - 404'd screenshot links, mangled ids, off-by-one paths. Every one of those
 * mistakes happens at the moment the model copies the string, and the correct string is already sitting in
 * the conversation. So this extension remembers the conversation's own inputs and resolves a small inline
 * marker to the real text:
 *
 *   <pi-ref type="url" offset="-1" />           the first URL in the most recent message (-2 is the one before)
 *   <pi-ref type="url" offset="-1" index="2" />  its second URL
 *   <pi-ref type="path" offset="7" />           the first path in message 7
 *   <pi-ref type="line" offset="-1" index="3" /> its third non-empty line
 *   <pi-ref type="text" offset="-1" />          the whole message, verbatim
 *   <pi-ref type="number" offset="-1" index="2" /> its second standalone number
 *   <pi-ref type="regex" offset="-1" pattern="issue (\\d+)" /> what your own regex captures
 *   <pi-date value="date" offset="+3d" format="%Y-%m" /> a computed date in any strftime shape
 *   <pi-file pattern="bench/*.py" index="1" />  a path that really exists on disk
 *   <pi-task status="running" part="id" />      a background task of this project
 *   <pi-tool index="2" part="name" />           a tool the session really has (<pi-tools /> lists them)
 *   <pi-repo part="root|branch|head|remote|dirty" />  the git repository this session is in
 *   <pi-session part="id|model|provider|cwd|os" />    this session id, model, working directory
 *   <pi-history pattern="eval_suite" />         an earlier tool call, so it is not retyped
 *   <pi-result pattern="prefill" context="240" /> what an earlier tool call returned
 *   <pi-env name="HF_ENDPOINT" default="" />    the value of an environment variable
 *   <pi-skill name="lilypond-music" />          the absolute path of an installed skill
 *   <pi-var id="mini" value="ssh macminister.local" /> define a variable, <pi-var id="mini" /> use it
 *   <pi-vars />                                 list every captured value and which tag produced it
 *   <pi-pr n="12" />                            a tag you defined in JSON
 *
 * Every tag also stores what it resolved to: give it `id="target"` and `<pi-var id="target" />` cites it
 * again; without an id it gets a random one, which `<pi-vars />` lists with its source.
 *
 * `offset` picks the message, `index` picks the entry inside it. Every built-in refuses loudly when it finds
 * nothing, and the refusal names what does exist - a guess is only useful if a wrong one is visible.
 *
 * The `pi-` prefix exists so a tag is never confused with an HTML element; the bare spelling still works. Tags
 * are used instead of `@tokens` because tool arguments and prose are full of `@scope/package`, email addresses
 * and npm names. Every other tag name is yours, declared in `tags` by its bare name (`"pr"` is written
 * `<pi-pr />`), with a `description` so the model is told what it is for; its text can be a literal, a
 * template, a hook, or JavaScript you wrote in the JSON itself.
 *
 * Config: `<agentDir>/pi-inline-tags.json` (override with PI_INLINE_TAGS_CONFIG):
 *   {
 *     "enabled": true,
 *     "models": ["qwen3.8"],                  // guidance only; resolution always runs when enabled
 *     "refIndexSize": 6,                      // how many pasted links to name in the prompt
 *     "expandToolCalls": true,
 *     "expandAssistant": true,
 *     "expandUserInput": true,
 *     "promptHook": "morning_note",           // a hook whose text is appended to the system prompt
 *     "hookTimeoutMs": 2000,
 *     "hookCacheSeconds": 5,
 *     "disableTags": ["date"],                // drop a default tag
 *     "skillRoots": ["~/my-skills"],          // extra places <pi-skill /> looks
 *     "vars": { "box": "macminister.local" },  // variables that start defined
 *     "tags": {
 *       "host":   { "value": "ssh macminister.local", "description": "the mac mini every bench command runs on" },
 *       "pr":     { "template": "https://github.com/voorjaar/v1gate/pull/{n}", "attrs": ["n"] },
 *       "shot":   { "hook": "screenshot", "attrs": ["days"] },
 *       "due":    { "js": true },                     // <agentDir>/tags/due.js: export default (attrs, ctx) => …
 *       "shot":   { "js": "tools/shot.js" },          // or a path, resolved against the config dir
 *       "ticket": { "pattern": "\\[\\[ticket\\s+(\\d+)\\]\\]", "template": "https://tracker.local/t/{1}" }
 *     }
 *   }
 *
 * A tag's code is one file with one default export (`<agentDir>/tags/<name>.js`):
 *   export const description = "the URL from two messages back";
 *   export default (attrs, ctx) => ctx.message('-2', 'url');
 *
 * Hooks (JS, ESM; default file `<config dir>/pi-inline-tags.hooks.js`, override with `hooksFile`):
 *   export const host = () => "ssh macminister.local";
 *   export const due = ({ modifier, attrs }) => shiftDueDate(modifier ?? attrs.days);
 *   export async function screenshot({ attrs }) { return latestShot(attrs.days); }
 *   export const tags = { shot: { hook: "screenshot" } };   // a hook file may declare tags too
 *
 * Environment: `PI_INLINE_TAGS=off` disables everything. `/refs` lists what resolves,
 * `/inline-tags status|on|off` inspects the extension.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform, arch } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONFIG_FILE_NAME = "pi-inline-tags.json";
const CONFIG_PATH_ENV = "PI_INLINE_TAGS_CONFIG";
const HOOKS_FILE_NAME = "pi-inline-tags.hooks.js";

const DEFAULT_REF_INDEX_SIZE = 6;
const DEFAULT_HOOK_TIMEOUT_MS = 2000;
const DEFAULT_HOOK_CACHE_SECONDS = 5;
const MAX_REF_VALUE_CHARS = 4000;
const MAX_REF_DEPTH = 3;
const MAX_GUIDELINE_CHARS = 8000;
const MAX_INDEX_LINE_CHARS = 170;
const MAX_TAGS = 60;
const MAX_PATTERN_CHARS = 400;
const MAX_GLOB_FILES = 4000;
const MAX_GLOB_DEPTH = 8;
const MAX_TASK_RECORDS = 300;
const MAX_HISTORY_SCAN = 600;
const MAX_SKILL_DEPTH = 4;
const MAX_VARS = 60;
const MAX_AUTO_VARS = 24;
const VAR_FILE_NAME = "pi-inline-vars.json";
const MAX_LIST_ITEMS = 20;

/**
 * A tag's code lives in its own file: `<agentDir>/tags/<name>.js`, one tag per script.
 * `"js": true` or a bare name picks `tags/<name>.js`; a path (`"js": "tools/shot.js"`) is resolved
 * against the config directory, the tags directory, or absolutely.
 */
function resolveTagScript(name: string, value: string | boolean, configDir: string): string | undefined {
  const tagsDir = join(configDir, "tags");
  const candidates: string[] = [];
  if (value === true) candidates.push(join(tagsDir, `${name}.js`), join(configDir, `${name}.js`));
  else {
    const given = expandHome(value);
    if (given.endsWith(".js")) candidates.push(given, join(configDir, given), join(tagsDir, given));
    else candidates.push(join(tagsDir, `${given}.js`), join(configDir, `${given}.js`), join(tagsDir, `${name}.js`));
  }
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next spelling
    }
  }
  return undefined;
}

type TagScriptModule = { default?: unknown; description?: unknown; attrs?: unknown };
const tagScriptCache = new Map<string, Promise<TagScriptModule | undefined>>();

function loadTagScript(path: string): Promise<TagScriptModule | undefined> {
  const hit = tagScriptCache.get(path);
  if (hit) return hit;
  const loaded = importModule(pathToFileURL(path).href)
    .then((mod) => (mod && typeof mod === "object" ? (mod as TagScriptModule) : undefined))
    .catch(() => undefined);
  tagScriptCache.set(path, loaded);
  return loaded;
}

async function importModule(url: string): Promise<unknown> {
  return await import(url);
}

/** `<pi-file pattern="bench/*.py" />` globs: `*` `?` `**` and {a,b}. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") { i += 1; out += "(?:.*/)?"; } else out += ".*";
      } else out += "[^/]*";
    } else if (char === "?") out += "[^/]";
    else if (char === "[") {
      const end = glob.indexOf("]", i);
      if (end === -1) out += "\[";
      else { out += glob.slice(i, end + 1); i = end; }
    } else if (char === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) out += "\\{";
      else { out += `(?:${glob.slice(i + 1, end).split(",").map((alt) => globToRegExp(alt.trim()).source.slice(1, -1)).join("|")})`; i = end; }
    } else out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** What each built-in tag is for, in the form the model is told. */
const BUILTIN_GUIDE: Record<string, string> = {
  ref: '<pi-ref type="url|path|line|text|number|regex|date" offset="-1" index="2" pattern="…" format="%Y-%m" scope="session" /> - a part of what the user pasted (offset picks the message, index the entry inside it)',
  date: '<pi-date value="date|datetime|time|today|yesterday|tomorrow|week|year" offset="+3d" format="%Y-%m" /> - a computed date',
  file: '<pi-file pattern="bench/*.py" index="1" sort="recent|name" absolute="true" all="true" /> - a path that really exists on disk instead of one you invented',
  task: '<pi-task status="running" match="bench" part="id|name|status|command|output|exit|age" all="true" /> - a background task of this project',
  tool: '<pi-tool index="1" part="name|description" match="web" scope="active|registered" all="true" /> - a tool the session really has (also <pi-tools />)',
  repo: '<pi-repo part="root|branch|head|remote|dirty" /> - the git repository this session is in',
  session: '<pi-session part="id|name|model|provider|cwd|dir|file|os" /> - this session id, model, working directory',
  history: '<pi-history pattern="eval_suite" part="command|tool|args" all="true" /> - an earlier tool call, so you do not retype it',
  result: '<pi-result pattern="prefill" part="text|tool" context="240" full="true" error="true" all="true" /> - what an earlier tool call returned',
  env: '<pi-env name="HF_ENDPOINT" default="" /> - the value of an environment variable',
  skill: '<pi-skill name="lilypond-music" file="scripts/x.py" /> - the absolute path of an installed skill',
  var: '<pi-var name="mini" value="ssh macminister.local" /> defines it, <pi-var name="mini" /> uses it, <pi-var name="mini" append="true" /> adds a line, <pi-vars /> lists them',
};

const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", ".hg", "dist", "build", "__pycache__", ".next", ".venv"]);

/** Bounded file walk: depth 8, 4000 files, no dependency trees. */
function walkFiles(root: string, maxFiles: number): Array<{ rel: string; mtimeMs: number }> {
  const found: Array<{ rel: string; mtimeMs: number }> = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && found.length < maxFiles) {
    const { dir, depth } = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) break;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || depth + 1 > MAX_GLOB_DEPTH) continue;
        stack.push({ dir: join(dir, entry.name), depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(join(dir, entry.name)).mtimeMs;
      } catch {
        continue;
      }
      found.push({ rel: entry.name, mtimeMs });
      found[found.length - 1]!.rel = join(relativeFor(root, join(dir, entry.name))).replace(/\\/g, "/");
    }
  }
  return found;
}

function relativeFor(root: string, abs: string): string {
  const base = root.endsWith("/") ? root : `${root}/`;
  return abs.startsWith(base) ? abs.slice(base.length) : abs;
}

/** Where to start walking so an absolute pattern does not scan the whole filesystem. */
function scanRoot(pattern: string, cwd: string): { base: string; inner: string } {
  const home = homedir();
  let base = cwd;
  let inner = pattern;
  if (pattern.startsWith("~/")) { base = home; inner = pattern.slice(2); }
  else if (pattern.startsWith("/")) { base = "/"; inner = pattern.slice(1); }
  const wildcard = inner.search(/[*?[{]/);
  if (wildcard > 0) {
    const head = inner.slice(0, wildcard);
    const keep = head.slice(0, head.lastIndexOf("/") + 1);
    if (keep.length > 0) base = join(base, keep);
    inner = inner.slice(keep.length);
  }
  return { base, inner };
}

type TaskRecord = {
  id: string;
  name: string;
  command: string;
  status: string;
  startTime: number;
  exitCode?: number | null;
  outputPath?: string;
  cwd?: string;
};

/** Background tasks pi-bg-handoff writes under <cwd>/.pi/tasks/<runId>/<id>.json. */
function readTaskRecords(roots: string[], limit: number): TaskRecord[] {
  const out: TaskRecord[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(root, entry);
      let files: string[];
      try {
        files = statSync(abs).isDirectory()
          ? readdirSync(abs).filter((name) => name.endsWith(".json")).map((name) => join(abs, name))
          : [abs];
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
          if (typeof raw.id !== "string") continue;
          out.push({
            id: raw.id,
            name: typeof raw.name === "string" ? raw.name : "",
            command: typeof raw.command === "string" ? raw.command : "",
            status: typeof raw.status === "string" ? raw.status : "unknown",
            startTime: typeof raw.startTime === "number" ? raw.startTime : 0,
            exitCode: typeof raw.exitCode === "number" ? raw.exitCode : null,
            outputPath: typeof raw.outputPath === "string" ? raw.outputPath : undefined,
            cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
          });
        } catch {
          continue;
        }
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
  }
  return out.sort((a, b) => b.startTime - a.startTime);
}

function gitText(args: string[], cwd: string): string | undefined {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] });
    const text = out.trim();
    return text ? text : undefined;
  } catch {
    return undefined;
  }
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

const USER_REF = /^u(-?\d+)(?:\.(url(\d*)|path|line(\d+)|text))?$/;
const ELEMENT_ATTR = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const URL_PATTERN = /https?:\/\/[^\s"'`<>()\[\]]+/g;
const PATH_PATTERN = /(?:~|\/)[A-Za-z0-9_./-]{3,}/g;

/** The shipped defaults. `tags` in the config adds to them, `disableTags` removes from them. */
const TAG_PREFIX = "pi-";
const BUILTIN_TAGS = ["ref", "date", "file", "task", "tool", "tools", "repo", "session", "history", "result", "env", "skill", "var", "vars"];

type TagSpec = {
  name: string;
  kind: "builtin" | "value" | "template" | "hook" | "script";
  value?: string;
  template?: string;
  hook?: string;
  script?: string;
  pattern?: string;
  attrs?: string[];
  description?: string;
  source: "builtin" | "config" | "hooks";
};

/** What a `js` tag body may reach for. No require/import: the context carries what is useful. */
type TagContext = {
  name: string;
  attrs: Record<string, string>;
  type?: string;
  offset?: string;
  index?: string;
  modifier?: string;
  match?: string;
  model?: string;
  cwd: string;
  env: (name: string) => string | undefined;
  now: () => string;
  date: (kind?: string, offset?: string, format?: string) => string;
  message: (index?: string, type?: string, number?: string) => string;
  userMessages: number;
};

type Config = {
  enabled: boolean;
  models: string[];
  refIndexSize: number;
  expandToolCalls: boolean;
  expandAssistant: boolean;
  expandUserInput: boolean;
  promptHook: string;
  hooksFile: string;
  hookTimeoutMs: number;
  hookCacheSeconds: number;
  disableTags: string[];
  skillRoots: string[];
  vars: Record<string, string>;
  tags: Record<string, TagSpec>;
};

const DEFAULT_CONFIG: Config = {
  enabled: true,
  models: [],
  refIndexSize: DEFAULT_REF_INDEX_SIZE,
  expandToolCalls: true,
  expandAssistant: true,
  expandUserInput: true,
  promptHook: "",
  hooksFile: "",
  hookTimeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
  hookCacheSeconds: DEFAULT_HOOK_CACHE_SECONDS,
  disableTags: [],
  skillRoots: [],
  vars: {},
  tags: {},
};

function resolveConfigPath(): string {
  const override = process.env[CONFIG_PATH_ENV];
  if (typeof override === "string" && override.trim()) return override.trim();
  const envDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir =
    typeof envDir === "string" && envDir.trim()
      ? envDir.trim().replace(/^~(?=$\/)/, homedir())
      : join(homedir(), ".pi", "agent");
  return join(agentDir, CONFIG_FILE_NAME);
}

function validTagName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(name);
}

/** One tag definition, validated. Returns undefined and reports the problem otherwise. */
function parseTag(rawName: string, raw: unknown, configDir: string): { spec?: TagSpec; problem?: string } {
  // `pi-` is how a tag is written in text; in config you may write it either way.
  const name = rawName.startsWith(TAG_PREFIX) ? rawName.slice(TAG_PREFIX.length) : rawName;
  if (!validTagName(name)) return { problem: `tag name "${rawName}" must be a short word (optionally prefixed with ${TAG_PREFIX})` };
  if (typeof raw === "string") return { spec: { name, kind: "value", value: raw, source: "config" } };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { problem: `tag "${name}" must be a string or an object` };

  const entry = raw as Record<string, unknown>;
  const spec: TagSpec = { name, kind: "builtin", source: "config" };
  const given: string[] = [];

  if (entry.value !== undefined) {
    if (typeof entry.value !== "string") return { problem: `tag "${name}".value must be a string` };
    spec.kind = "value";
    spec.value = entry.value;
    given.push("value");
  }
  if (entry.template !== undefined) {
    if (typeof entry.template !== "string") return { problem: `tag "${name}".template must be a string` };
    spec.kind = "template";
    spec.template = entry.template;
    given.push("template");
  }
  if (entry.hook !== undefined) {
    if (typeof entry.hook !== "string") return { problem: `tag "${name}".hook must be a hook name string` };
    spec.kind = "hook";
    spec.hook = entry.hook;
    given.push("hook");
  }
  const script = entry.js ?? entry.script ?? entry.file;
  if (script !== undefined) {
    if (typeof script !== "string" && script !== true) {
      return { problem: `tag "${name}".js must be a script path or true (inline JavaScript bodies are gone; the code lives in <agentDir>/tags/${name}.js)` };
    }
    const found = resolveTagScript(name, script, configDir);
    if (!found) return { problem: `tag "${name}".js does not point at a readable file - write one tag per script under ${join(configDir, "tags")}/` };
    spec.kind = "script";
    spec.script = found;
    given.push("js");
  }
  if (given.length > 1) return { problem: `tag "${name}" sets ${given.join(" and ")}; use one of value, template, hook, js` };
  if (given.length === 0) {
    // A file in tags/ is a tag even when the config only names it.
    const discovered = resolveTagScript(name, true, configDir);
    if (discovered) { spec.kind = "script"; spec.script = discovered; }
    else spec.kind = "builtin";
  }
  if (entry.pattern !== undefined) {
    if (typeof entry.pattern !== "string") return { problem: `tag "${name}".pattern must be a regex source string` };
    if (entry.pattern.length > MAX_PATTERN_CHARS) return { problem: `tag "${name}".pattern is longer than ${MAX_PATTERN_CHARS} characters` };
    try {
      new RegExp(entry.pattern, "g");
    } catch (error) {
      return { problem: `tag "${name}".pattern is not a valid regular expression: ${String(error)}` };
    }
    spec.pattern = entry.pattern;
  }
  if (entry.attrs !== undefined) {
    if (!Array.isArray(entry.attrs) || !entry.attrs.every((value) => typeof value === "string")) {
      return { problem: `tag "${name}".attrs must be an array of attribute names` };
    }
    spec.attrs = entry.attrs as string[];
  }
  if (entry.description !== undefined) {
    if (typeof entry.description !== "string") return { problem: `tag "${name}".description must be a string` };
    spec.description = entry.description.slice(0, 300);
  }
  if (spec.kind === "builtin" && !BUILTIN_TAGS.includes(name) && !spec.pattern) {
    return { problem: `tag "${name}" needs value, template, hook, or js (a pattern alone needs one of them to produce text)` };
  }
  return { spec };
}

function readConfig(): { path: string; config: Config; problems: string[] } {
  const path = resolveConfigPath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    return { path, config: { ...DEFAULT_CONFIG }, problems: code === "ENOENT" ? [] : [`could not read ${path}: ${String(error)}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { path, config: { ...DEFAULT_CONFIG }, problems: [`could not parse ${path}: ${String(error)}`] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { path, config: { ...DEFAULT_CONFIG }, problems: [`${path} must contain a JSON object`] };
  }

  const raw = parsed as Record<string, unknown>;
  const config: Config = { ...DEFAULT_CONFIG };
  const problems: string[] = [];

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
    else problems.push("enabled must be a boolean");
  }
  if (raw.models !== undefined) {
    if (Array.isArray(raw.models) && raw.models.every((value) => typeof value === "string")) config.models = raw.models as string[];
    else problems.push("models must be an array of strings");
  }
  if (raw.refIndexSize !== undefined) {
    const value = Number(raw.refIndexSize);
    if (Number.isInteger(value) && value >= 0 && value <= 20) config.refIndexSize = value;
    else problems.push("refIndexSize must be an integer between 0 and 20");
  }
  for (const key of ["expandToolCalls", "expandAssistant", "expandUserInput"] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] === "boolean") config[key] = raw[key];
      else problems.push(`${key} must be a boolean`);
    }
  }
  if (raw.promptHook !== undefined) {
    if (typeof raw.promptHook === "string") config.promptHook = raw.promptHook;
    else problems.push("promptHook must be a hook name string");
  }
  if (raw.hooksFile !== undefined) {
    if (typeof raw.hooksFile === "string") config.hooksFile = raw.hooksFile;
    else problems.push("hooksFile must be a path string");
  }
  if (raw.hookTimeoutMs !== undefined) {
    const value = Number(raw.hookTimeoutMs);
    if (Number.isInteger(value) && value >= 100 && value <= 15000) config.hookTimeoutMs = value;
    else problems.push("hookTimeoutMs must be an integer between 100 and 15000");
  }
  if (raw.hookCacheSeconds !== undefined) {
    const value = Number(raw.hookCacheSeconds);
    if (Number.isInteger(value) && value >= 0 && value <= 3600) config.hookCacheSeconds = value;
    else problems.push("hookCacheSeconds must be an integer between 0 and 3600");
  }
  if (raw.vars !== undefined) {
    if (raw.vars && typeof raw.vars === "object" && !Array.isArray(raw.vars)) {
      for (const [key, value] of Object.entries(raw.vars as Record<string, unknown>)) {
        if (typeof value === "string") config.vars[key] = value.slice(0, MAX_REF_VALUE_CHARS);
        else problems.push(`vars.${key} must be a string`);
      }
    } else problems.push("vars must be an object of name: text");
  }
  if (raw.disableTags !== undefined) {
    if (Array.isArray(raw.disableTags) && raw.disableTags.every((value) => typeof value === "string")) config.disableTags = raw.disableTags as string[];
    else problems.push("disableTags must be an array of tag names");
  }
  if (raw.skillRoots !== undefined) {
    if (Array.isArray(raw.skillRoots) && raw.skillRoots.every((value) => typeof value === "string")) config.skillRoots = raw.skillRoots as string[];
    else problems.push("skillRoots must be an array of directory paths");
  }
  if (raw.tags !== undefined) {
    if (!raw.tags || typeof raw.tags !== "object" || Array.isArray(raw.tags)) {
      problems.push("tags must be an object of name: definition");
    } else {
      const entries = Object.entries(raw.tags as Record<string, unknown>);
      if (entries.length > MAX_TAGS) problems.push(`tags has more than ${MAX_TAGS} entries`);
      for (const [name, definition] of entries.slice(0, MAX_TAGS)) {
        const result = parseTag(name, definition, dirname(path));
        if (result.spec) config.tags[name] = result.spec;
        if (result.problem) problems.push(result.problem);
      }
    }
  }

  return { path, config, problems };
}

// --- what a reference can point at ---------------------------------------------------------------

type UserMessage = { n: number; text: string; urls: string[]; paths: string[] };

type HookContext = {
  name: string;
  attrs: Record<string, string>;
  modifier?: string;
  match?: string;
  model?: string;
  cwd: string;
  userMessages: number;
};
type HookFn = (ctx: HookContext) => string | Promise<string>;

function captureMessage(text: string, n: number): UserMessage {
  const urls = (text.match(URL_PATTERN) ?? []).slice(0, 12);
  const paths = (text.match(PATH_PATTERN) ?? [])
    .filter((candidate) => !urls.some((url) => url.includes(candidate)))
    .slice(0, 12);
  return { n, text, urls, paths };
}

/** Numbers that stand on their own: the `1` in `v1gate` or `a1b2c3.png` is not a number you would cite. */
function numbersOf(text: string): string[] {
  return (text.match(/(?<![A-Za-z0-9_.])-?\d[\d,]*(?:\.\d+)?/g) ?? []).map((value) => value.replace(/,/g, "")).slice(0, 40);
}

function linesOf(message: UserMessage): string[] {
  return message.text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

const MS_UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The `%` tokens `<pi-date format="..." />` understands. An unknown one is left as written. */
function strftime(date: Date, format: string): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const isoWeek = (value: Date): { year: number; week: number } => {
    const probe = new Date(value.getFullYear(), value.getMonth(), value.getDate());
    probe.setDate(probe.getDate() + 3 - ((probe.getDay() + 6) % 7));
    const year = probe.getFullYear();
    const firstOfYear = new Date(year, 0, 1);
    const week = 1 + Math.round(((probe.getTime() - firstOfYear.getTime()) / 86_400_000 - 3 + ((firstOfYear.getDay() + 6) % 7)) / 7);
    return { year, week };
  };
  const dayOfYear = 1 + Math.floor((date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86_400_000);
  const iso = isoWeek(date);
  const tokens: Record<string, string> = {
    Y: String(date.getFullYear()),
    G: String(iso.year),
    m: pad(date.getMonth() + 1),
    b: MONTHS[date.getMonth()]!.slice(0, 3),
    B: MONTHS[date.getMonth()]!,
    d: pad(date.getDate()),
    F: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    j: pad(dayOfYear, 3),
    W: pad(Math.floor((dayOfYear - 1 + ((date.getDay() + 6) % 7)) / 7)),
    V: String(iso.week),
    u: String(((date.getDay() + 6) % 7) + 1),
    w: String(date.getDay()),
    a: WEEKDAYS[date.getDay()]!.slice(0, 3),
    A: WEEKDAYS[date.getDay()]!,
    H: pad(date.getHours()),
    M: pad(date.getMinutes()),
    S: pad(date.getSeconds()),
    T: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    Q: String(Math.floor(date.getMonth() / 3) + 1),
    s: String(Math.floor(date.getTime() / 1000)),
    "%": "%",
  };
  return format.replace(/%([A-Za-z%])/g, (whole, key: string) => tokens[key] ?? whole);
}

function dateValue(kind: string, modifier?: string, format?: string): string | undefined {
  const base = new Date();
  if (kind === "yesterday") base.setDate(base.getDate() - 1);
  if (kind === "tomorrow") base.setDate(base.getDate() + 1);
  if (modifier) {
    const match = /^([+-])(\d+)([mhdw])$/.exec(modifier);
    if (!match) return undefined;
    const amount = Number(match[2]) * (match[1] === "-" ? -1 : 1);
    base.setTime(base.getTime() + amount * (MS_UNITS[match[3] ?? "d"] ?? 0));
  }
  if (format) return strftime(base, format);
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
  const clock = `${pad(base.getHours())}:${pad(base.getMinutes())}`;
  switch (kind.toLowerCase()) {
    case "date":
    case "today":
      return day;
    case "time":
      return clock;
    case "datetime":
      return `${day} ${clock}`;
    case "year":
      return String(base.getFullYear());
    case "week": {
      const probe = new Date(base.getFullYear(), base.getMonth(), base.getDate());
      probe.setDate(probe.getDate() + 3 - ((probe.getDay() + 6) % 7));
      const firstOfYear = new Date(probe.getFullYear(), 0, 1);
      const week = 1 + Math.round(((probe.getTime() - firstOfYear.getTime()) / 86_400_000 - 3 + ((firstOfYear.getDay() + 6) % 7)) / 7);
      return `${probe.getFullYear()}-W${pad(week)}`;
    }
    default:
      return undefined;
  }
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(ELEMENT_ATTR)) attrs[(match[1] ?? "").toLowerCase()] = match[2] ?? match[3] ?? "";
  return attrs;
}

/** Replace {name} and {1} placeholders in a user template with attributes or capture groups. */
function fillTemplate(template: string, attrs: Record<string, string>): { text?: string; missing?: string[] } {
  const missing: string[] = [];
  const text = template.replace(/\{([^{}]+)\}/g, (_whole, key: string) => {
    const value = attrs[key];
    if (value === undefined) {
      missing.push(key);
      return `{${key}}`;
    }
    return value;
  });
  return missing.length > 0 ? { text, missing } : { text };
}

async function loadHooks(path: string, configDir: string): Promise<{ hooks: Map<string, HookFn>; tags: TagSpec[]; problems: string[] }> {
  const hooks = new Map<string, HookFn>();
  const tags: TagSpec[] = [];
  if (!path) return { hooks, tags, problems: [] };
  const resolved = expandHome(path);
  if (!existsSync(resolved)) return { hooks, tags, problems: [] };
  let module: Record<string, unknown>;
  try {
    const stat = statSync(resolved);
    if (stat.size > 512_000) return { hooks, tags, problems: [`hooks file is larger than 512 KB: ${resolved}`] };
    module = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
  } catch (error) {
    return { hooks, tags, problems: [`could not load hooks from ${resolved}: ${String(error)}`] };
  }

  const exported: Record<string, unknown> = {};
  const defaultExport = module.default;
  if (defaultExport && typeof defaultExport === "object" && !Array.isArray(defaultExport)) {
    Object.assign(exported, defaultExport as Record<string, unknown>);
  }
  for (const [key, value] of Object.entries(module)) {
    if (key === "default") continue;
    exported[key] = value;
  }

  const problems: string[] = [];
  for (const [key, value] of Object.entries(exported)) {
    if (key === "tags") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        problems.push("hooks export \"tags\" must be an object of tag definitions");
        continue;
      }
      for (const [name, definition] of Object.entries(value as Record<string, unknown>)) {
        const result = parseTag(name, definition, configDir);
        if (result.spec) tags.push({ ...result.spec, source: "hooks" });
        if (result.problem) problems.push(result.problem);
      }
      continue;
    }
    if (!validTagName(key)) {
      problems.push(`hooks export "${key}" is not a usable name`);
      continue;
    }
    if (typeof value === "function") hooks.set(key, value as HookFn);
    else if (typeof value === "string") hooks.set(key, () => value);
    else problems.push(`hooks export "${key}" must be a function or a string`);
  }
  return { hooks, tags, problems };
}

// --- activation --------------------------------------------------------------------------------

export default function piInlineTags(pi: ExtensionAPI): void {
  const loaded = readConfig();
  const config = loaded.config;
  const envSwitch = (process.env.PI_INLINE_TAGS ?? "").trim().toLowerCase();
  let enabled = config.enabled && envSwitch !== "off" && envSwitch !== "0";

  const hooksPath = config.hooksFile ? expandHome(config.hooksFile) : join(dirname(loaded.path), HOOKS_FILE_NAME);
  let hooks = new Map<string, HookFn>();
  const hookProblems: string[] = [];
  const hooksReady = loadHooks(hooksPath, dirname(loaded.path)).then((result) => {
    hooks = result.hooks;
    hookProblems.push(...result.problems);
    // Tags the hook file declares are merged in, so a JS file can define syntax too, not just values.
    for (const spec of result.tags) if (!config.tags[spec.name]) config.tags[spec.name] = spec;
    // A hook function is callable as a tag as well, so `due` in the hooks file means <pi-due modifier="+3d" />.
    for (const name of result.hooks.keys()) {
      if (config.tags[name] || BUILTIN_TAGS.includes(name)) continue;
      config.tags[name] = { name, kind: "hook", hook: name, source: "hooks" };
    }
    rebuildScanners();
    return hooks;
  });

  const userMessages: UserMessage[] = [];
  const seenTexts = new Set<string>();
  const hookCache = new Map<string, { at: number; value: string }>();
  const applied: string[] = [];

  // --- the scanner is built from what is configured, not from a fixed pattern ---------------------
  let tagNames: string[] = [];
  let tagPatterns: Array<{ name: string; regex: RegExp; spec: TagSpec }> = [];
  let elementScanner: RegExp | undefined;

  function rebuildScanners(): void {
    const disabled = new Set(config.disableTags);
    const specs: TagSpec[] = [];
    for (const name of BUILTIN_TAGS) if (!disabled.has(name)) specs.push({ name, kind: "builtin", source: "builtin" });
    for (const spec of Object.values(config.tags)) if (!disabled.has(spec.name)) specs.push(spec);
    const spellings: string[] = [];
    for (const spec of specs) {
      if (spec.pattern) continue;
      spellings.push(`${TAG_PREFIX}${spec.name}`, spec.name);
    }
    // Longest first, so `<pi-ref>` is never read as `<pi>` + leftover.
    spellings.sort((a, b) => b.length - a.length);
    tagNames = spellings;
    tagPatterns = specs
      .filter((spec) => spec.pattern)
      .map((spec) => ({ name: spec.name, spec, regex: new RegExp(spec.pattern as string, "g") }))
      .filter((entry) => entry.regex.source.length <= MAX_PATTERN_CHARS + 4);
    // A quoted attribute value may itself hold an element, so quotes are matched before `>` is excluded.
    elementScanner = tagNames.length > 0 ? new RegExp(`<(${tagNames.join("|")})\\b((?:'[^']*'|"[^"]*"|[^>])*)\\/?>`, "g") : undefined;
  }
  rebuildScanners();

  const recordUser = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const key = `${trimmed.length}:${trimmed.slice(0, 200)}`;
    if (seenTexts.has(key)) return;
    seenTexts.add(key);
    userMessages.push(captureMessage(text, userMessages.length + 1));
  };

  const note = (text: string): void => {
    applied.push(text);
    if (applied.length > 25) applied.shift();
  };

  const modelOf = (ctx?: ExtensionContext): string | undefined => {
    const model = ctx?.model as { provider?: string; id?: string } | undefined;
    return model ? `${model.provider ?? ""}/${model.id ?? ""}` : undefined;
  };

  const callHook = async (name: string, info: Omit<HookContext, "name">): Promise<string | undefined> => {
    const fn = hooks.get(name);
    if (!fn) return undefined;
    const cacheKey = `${name}|${Object.entries(info.attrs).sort().join(",")}|${info.modifier ?? ""}`;
    const hit = hookCache.get(cacheKey);
    if (hit && Date.now() - hit.at < config.hookCacheSeconds * 1000) return hit.value;
    const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), config.hookTimeoutMs));
    let outcome: unknown;
    try {
      outcome = await Promise.race([Promise.resolve(fn({ name, ...info })).catch(() => undefined), timeout]);
    } catch {
      outcome = undefined;
    }
    if (typeof outcome !== "string" || !outcome.trim()) {
      note(`hook ${name} returned nothing`);
      return undefined;
    }
    const value = outcome.slice(0, MAX_REF_VALUE_CHARS);
    hookCache.set(cacheKey, { at: Date.now(), value });
    return value;
  };

  /** The only tokens the extension builds itself: `u-1.url2` from <pi-ref type="url" offset="-1" index="2" />. */
  const resolveUserMessagePart = (token: string): { value?: string; missing?: string } => {
    const userMatch = USER_REF.exec(token);
    if (!userMatch) return {};
    const requested = Number(userMatch[1]);
    const n = requested > 0 ? requested : userMessages.length + requested + 1;
    const message = userMessages[n - 1];
    const range = `this session has ${userMessages.length} user message${userMessages.length === 1 ? "" : "s"} (offset="-1" is the most recent)`;
    if (!message || n < 1) return { missing: `offset="${userMatch[1]}" points outside the conversation - ${range}` };
    // "url2" and "line3" carry their ordinal inside the part name.
    const rawPart = userMatch[2] ?? "";
    const part = rawPart.replace(/\d+$/, "");
    const ordinal = Number((rawPart.match(/\d+$/) ?? [])[0] || userMatch[3] || userMatch[4] || "1");
    if (!part || part === "text") return { value: message.text.trim().slice(0, MAX_REF_VALUE_CHARS) };
    if (part === "url") {
      const url = message.urls[ordinal - 1];
      return url ? { value: url } : { missing: `message ${n} has ${message.urls.length} URL${message.urls.length === 1 ? "" : "s"}, so index="${ordinal}" resolves to nothing` };
    }
    if (part === "path") {
      const found = message.paths[ordinal - 1];
      return found ? { value: found } : { missing: `message ${n} contains no path` };
    }
    const lines = linesOf(message);
    const line = lines[ordinal - 1];
    return line ? { value: line } : { missing: `message ${n} has ${lines.length} non-empty line${lines.length === 1 ? "" : "s"}, not ${ordinal}` };
  };

  const resolveSpec = async (
    spec: TagSpec,
    attrs: Record<string, string>,
    ctx: ExtensionContext | undefined,
  ): Promise<{ value?: string; missing?: string }> => {
    if (spec.kind === "value") return { value: spec.value };
    if (spec.kind === "template") {
      const filled = fillTemplate(spec.template ?? "", attrs);
      if (filled.missing && filled.missing.length > 0) {
        return { missing: `tag <${spec.name}> needs ${filled.missing.map((key) => `${key}="…"`).join(" ")}` };
      }
      if (depthOf(attrs) < MAX_REF_DEPTH) return { value: filled.text };
      return { value: filled.text };
    }
    if (spec.kind === "hook") {
      const value = await callHook(spec.hook ?? spec.name, {
        attrs,
        modifier: attrs.modifier ?? attrs.offset,
        model: modelOf(ctx),
        cwd: process.cwd(),
        userMessages: userMessages.length,
      });
      // Hooks are user code and may be flaky (network, ssh): the text stays as written and /refs records it.
      return value === undefined ? {} : { value };
    }
    if (spec.kind === "script") {
      const value = await runTagCode(spec, attrs, ctx);
      return value === undefined ? { missing: `tag <${TAG_PREFIX}${spec.name}> script ${spec.script ?? ""} returned nothing (its default export must return a string)` } : { value };
    }
    return { missing: `tag <${spec.name}> has no value, template, hook, or js` };
  };

  const tagFunctions = new Map<string, TagFn>();

  const tagContextFor = (spec: TagSpec, attrs: Record<string, string>, ctx: ExtensionContext | undefined): TagContext => ({
    name: spec.name,
    attrs,
    type: attrs.type,
    offset: attrs.offset,
    index: attrs.index,
    modifier: attrs.modifier ?? attrs.offset,
    match: attrs.match,
    model: modelOf(ctx),
    cwd: process.cwd(),
    env: (name: string) => process.env[name],
    now: () => new Date().toISOString(),
    date: (kind = "date", offset?: string, format?: string) => dateValue(kind, offset, format) ?? dateValue("date") ?? "",
    message: (offset = "-1", type = "text", index?: string) => {
      const requested = Number(offset);
      const n = Number.isFinite(requested) ? (requested > 0 ? requested : userMessages.length + requested + 1) : userMessages.length;
      const message = userMessages[n - 1];
      if (!message) return "";
      if (type === "url" || type === "path") return (type === "url" ? message.urls : message.paths)[Number(index ?? "1") - 1] ?? "";
      if (type === "line") return linesOf(message)[Number(index ?? "1") - 1] ?? "";
      return message.text.trim();
    },
    userMessages: userMessages.length,
  });

  const runTagCode = async (spec: TagSpec, attrs: Record<string, string>, ctx: ExtensionContext | undefined): Promise<string | undefined> => {
    let fn = tagFunctions.get(spec.name);
    if (!fn) {
      const mod = spec.script ? await loadTagScript(spec.script) : undefined;
      if (!mod || typeof mod.default !== "function") {
        note(`tag ${spec.name} script ${spec.script ?? ""} has no default export function`);
        return undefined;
      }
      if (!spec.description && typeof mod.description === "string") spec.description = mod.description.slice(0, 300);
      fn = mod.default as TagFn;
      tagFunctions.set(spec.name, fn);
    }
    const cacheKey = `script:${spec.name}|${Object.entries(attrs).sort().join(",")}`;
    const hit = hookCache.get(cacheKey);
    if (hit && Date.now() - hit.at < config.hookCacheSeconds * 1000) return hit.value;
    const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), config.hookTimeoutMs));
    let outcome: unknown;
    try {
      outcome = await Promise.race([Promise.resolve(fn(attrs, tagContextFor(spec, attrs, ctx))).catch(() => undefined), timeout]);
    } catch {
      outcome = undefined;
    }
    if (typeof outcome !== "string" || !outcome.trim()) {
      note(`tag ${spec.name} script returned nothing (the default export must return a string)`);
      return undefined;
    }
    const value = outcome.slice(0, MAX_REF_VALUE_CHARS);
    hookCache.set(cacheKey, { at: Date.now(), value });
    return value;
  };

  const resolveDateAttrs = (attrs: Record<string, string>): { value?: string; missing?: string } => {
    const kind = attrs.value ?? attrs.kind ?? "date";
    const format = attrs.format ?? attrs.style;
    if (format !== undefined && format.length > 64) return { missing: `format="${format}" is longer than 64 characters` };
    const value = dateValue(kind, attrs.offset, format);
    return value
      ? { value }
      : { missing: `<pi-date value="${kind}" offset="${attrs.offset ?? ""}" /> - value must be date, datetime, time, today, yesterday, tomorrow, week or year, and offset must look like +3d, -2h, +10m, +1w` };
  };

  const resolveDirect = async (
    request: DirectRequest,
    attrs: Record<string, string>,
    ctx: ExtensionContext | undefined,
    depth: number,
  ): Promise<{ value?: string; missing?: string }> => {
    const cwd = ctx?.cwd ?? process.cwd();
    if (request.kind === "date") return resolveDateAttrs(attrs);
    if (request.kind === "file") return resolveFileTag(attrs, cwd);
    if (request.kind === "task") return resolveTaskTag(attrs, cwd);
    if (request.kind === "tool") return resolveToolTag(attrs);
    if (request.kind === "repo") return resolveRepoTag(attrs, cwd);
    if (request.kind === "session") return resolveSessionTag(attrs, ctx, cwd);
    if (request.kind === "history") return resolveHistoryTag(attrs, ctx);
    if (request.kind === "result") return resolveResultTag(attrs, ctx);
    if (request.kind === "env") return resolveEnvTag(attrs);
    if (request.kind === "skill") return resolveSkillTag(attrs, cwd);
    if (request.kind === "var") {
      const stored = resolveVarTag(attrs, cwd);
      if (stored.value === undefined) return stored;
      if (depth < MAX_REF_DEPTH && stored.value.includes("<")) return { value: (await expandText(stored.value, depth + 1, ctx)).text };
      return stored;
    }
    if (request.kind === "vars") return resolveVarsTag();
    const offset = attrs.offset ?? attrs.message ?? "-1";
    if (!/^-?\d+$/.test(offset)) return { missing: `offset="${offset}" must be a message offset (offset="-1" is the most recent)` };
    const requested = Number(offset);
    const n = requested > 0 ? requested : userMessages.length + requested + 1;
    const scope = (attrs.scope ?? "message").toLowerCase();
    const messages = scope === "session"
      ? [...userMessages].reverse()
      : userMessages[n - 1]
        ? [userMessages[n - 1]!]
        : [];
    if (messages.length === 0) {
      return { missing: `offset="${offset}" points outside the conversation - this session has ${userMessages.length} user message${userMessages.length === 1 ? "" : "s"}` };
    }
    const where = scope === "session" ? "this session" : `message ${n}`;
    const ordinal = Number(attrs.index ?? "1") || 1;

    if (request.kind === "number") {
      const found = messages.flatMap((message) => numbersOf(message.text));
      const value = found[ordinal - 1];
      return value
        ? { value }
        : { missing: `no ${ordinal}${ordinal === 1 ? "st" : ordinal === 2 ? "nd" : ordinal === 3 ? "rd" : "th"} number in ${where} (${found.length} found)` };
    }

    const pattern = attrs.pattern ?? attrs.source;
    if (!pattern) return { missing: '<pi-ref type="regex" /> needs pattern="…"' };
    if (pattern.length > MAX_PATTERN_CHARS) return { missing: `pattern is longer than ${MAX_PATTERN_CHARS} characters` };
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "g");
    } catch (error) {
      return { missing: `pattern="${pattern}" is not a valid regular expression: ${String(error)}` };
    }
    const matches: string[] = [];
    for (const message of messages) {
      for (const match of message.text.matchAll(regex)) {
        matches.push(match[1] ?? match[0]);
        if (matches.length >= ordinal) break;
      }
      if (matches.length >= ordinal) break;
    }
    const value = matches[ordinal - 1];
    return value
      ? { value: value.slice(0, MAX_REF_VALUE_CHARS) }
      : { missing: `pattern="${pattern}" matched nothing in ${where}` };
  };

  // --- what the session already did: calls and their results ---------------------------------------
  type LooseEntry = { message?: { role?: string; toolName?: string; toolCallId?: string; command?: string; isError?: boolean; content?: unknown } };

  const sessionEntries = (ctx?: ExtensionContext): LooseEntry[] => {
    const manager = (ctx as { sessionManager?: { getEntries?: () => LooseEntry[] } } | undefined)?.sessionManager;
    try {
      return manager?.getEntries?.() ?? [];
    } catch {
      return [];
    }
  };

  type CallRecord = { tool: string; command: string; id: string };

  const sessionCalls = (ctx?: ExtensionContext): CallRecord[] => {
    const out: CallRecord[] = [];
    for (const entry of sessionEntries(ctx)) {
      const message = entry.message;
      if (!message) continue;
      if (message.role === "bashExecution" && typeof message.command === "string") {
        out.push({ tool: "bash", command: message.command, id: message.toolCallId ?? "" });
        continue;
      }
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const raw of message.content as Array<{ type?: string; name?: string; id?: string; arguments?: Record<string, unknown> }>) {
        if (!raw || raw.type !== "toolCall") continue;
        const args = raw.arguments ?? {};
        const command = ["command", "path", "pattern", "query", "url", "symbol", "content"]
          .map((key) => (typeof args[key] === "string" ? (args[key] as string) : undefined))
          .find((value) => value !== undefined) ?? JSON.stringify(args);
        out.push({ tool: String(raw.name ?? ""), command, id: String(raw.id ?? "") });
        if (out.length >= MAX_HISTORY_SCAN) return out;
      }
    }
    return out;
  };

  type ResultRecord = { tool: string; text: string; id: string; error: boolean };

  const sessionResults = (ctx?: ExtensionContext): ResultRecord[] => {
    const out: ResultRecord[] = [];
    for (const entry of sessionEntries(ctx)) {
      const message = entry.message;
      if (!message || message.role !== "toolResult") continue;
      const parts = Array.isArray(message.content)
        ? (message.content as Array<{ type?: string; text?: string }>).map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
        : "";
      out.push({ tool: String(message.toolName ?? ""), text: parts, id: String(message.toolCallId ?? ""), error: message.isError === true });
      if (out.length >= MAX_HISTORY_SCAN) return out;
    }
    return out;
  };

  /** A pattern is a regular expression when it compiles as one, otherwise a plain substring. */
  const findPattern = (text: string, pattern: string): { start: number; end: number } => {
    try {
      const match = new RegExp(pattern, "g").exec(text);
      if (match) return { start: match.index, end: match.index + match[0].length };
    } catch {
      // fall through to a literal search
    }
    const at = text.toLowerCase().indexOf(pattern.toLowerCase());
    return at === -1 ? { start: -1, end: -1 } : { start: at, end: at + pattern.length };
  };

  const windowAround = (text: string, start: number, end: number, radius: number): string => {
    const from = Math.max(0, start - radius);
    const to = Math.min(text.length, end + radius);
    return `${from > 0 ? "... " : ""}${text.slice(from, to).trim()}${to < text.length ? " ..." : ""}`;
  };

  const resolveFileTag = (attrs: Record<string, string>, cwd: string): { value?: string; missing?: string } => {
    const pattern = attrs.pattern ?? attrs.glob;
    if (!pattern) return { missing: '<pi-file /> needs pattern="bench/*.py" (relative to the working directory, or absolute /… or ~/…)' };
    if (pattern.length > MAX_PATTERN_CHARS) return { missing: `pattern is longer than ${MAX_PATTERN_CHARS} characters` };
    const { base, inner } = scanRoot(pattern, cwd);
    const regex = globToRegExp(inner);
    const files = walkFiles(base, MAX_GLOB_FILES);
    const hits = files.filter((file) => regex.test(file.rel));
    if (hits.length === 0) return { missing: `no file matches pattern="${pattern}" under ${base} (${files.length} file${files.length === 1 ? "" : "s"} looked at)` };
    const sort = (attrs.sort ?? "recent").toLowerCase();
    hits.sort(sort === "name" ? (a, b) => a.rel.localeCompare(b.rel) : (a, b) => b.mtimeMs - a.mtimeMs);
    // Paths come back relative to the working directory, the way every other tool names a file.
    const show = (rel: string) => {
      const abs = join(base, rel);
      if (attrs.absolute === "true") return abs;
      const fromCwd = relative(cwd, abs);
      return fromCwd && !fromCwd.startsWith("..") ? fromCwd : rel;
    };
    if (attrs.all === "true") {
      const listed = hits.slice(0, MAX_LIST_ITEMS).map((file) => show(file.rel));
      return { value: listed.join("\n") + (hits.length > listed.length ? `\n(${hits.length - listed.length} more)` : "") };
    }
    const ordinal = Number(attrs.index ?? "1") || 1;
    const hit = hits[ordinal - 1];
    if (!hit) return { missing: `pattern="${pattern}" matched ${hits.length} file${hits.length === 1 ? "" : "s"}; index="${ordinal}" resolves to nothing` };
    return { value: show(hit.rel) };
  };

  const resolveTaskTag = (attrs: Record<string, string>, cwd: string): { value?: string; missing?: string } => {
    const records = readTaskRecords([join(cwd, ".pi", "tasks"), join(homedir(), ".pi", "tasks")], MAX_TASK_RECORDS);
    const status = (attrs.status ?? "any").toLowerCase();
    const wanted = status === "any" || status === "all" ? undefined : status;
    const filter = attrs.match;
    const hits = records.filter((task) => {
      if (wanted && task.status !== wanted) return false;
      if (filter && findPattern(`${task.name} ${task.command}`, filter).start === -1) return false;
      return true;
    });
    if (hits.length === 0) {
      const summary = records.length === 0
        ? "this project has no recorded background tasks"
        : `recorded tasks: ${records.slice(0, 5).map((task) => `${task.id} ${task.status} ${task.name || task.command.slice(0, 30)}`).join(", ")}`;
      return { missing: `no background task matches${wanted ? ` status="${wanted}"` : ""}${filter ? ` match="${filter}"` : ""} - ${summary}` };
    }
    const part = (attrs.part ?? "id").toLowerCase();
    if (attrs.all === "true") {
      return { value: hits.slice(0, MAX_LIST_ITEMS).map((task) => `${task.id} ${task.status} ${task.name || task.command.slice(0, 40)}`).join("\n") };
    }
    const ordinal = Number(attrs.index ?? "1") || 1;
    const task = hits[ordinal - 1];
    if (!task) return { missing: `${hits.length} task${hits.length === 1 ? "" : "s"} matched; index="${ordinal}" resolves to nothing` };
    if (part === "name") return { value: task.name || "(unnamed)" };
    if (part === "status") return { value: task.status };
    if (part === "command") return { value: task.command.slice(0, MAX_REF_VALUE_CHARS) };
    if (part === "output") return task.outputPath ? { value: task.outputPath } : { missing: `task ${task.id} recorded no output path` };
    if (part === "exit") return { value: task.exitCode === null || task.exitCode === undefined ? "still running" : String(task.exitCode) };
    if (part === "age") {
      const seconds = Math.max(0, Math.round((Date.now() - task.startTime) / 1000));
      return { value: seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.round(seconds / 60)}m ago` : `${Math.round(seconds / 3600)}h ago` };
    }
    return { value: task.id };
  };

  const resolveToolTag = (attrs: Record<string, string>): { value?: string; missing?: string } => {
    const registered = (() => {
      try {
        return pi.getAllTools().map((tool) => ({ name: tool.name, description: typeof tool.description === "string" ? tool.description : "" }));
      } catch {
        return [];
      }
    })();
    const active = (() => {
      try {
        return pi.getActiveTools();
      } catch {
        return [];
      }
    })();
    const scope = (attrs.scope ?? "active").toLowerCase();
    const pool = scope === "registered" || scope === "all" ? registered : registered.filter((tool) => active.includes(tool.name));
    const hits = attrs.match ? pool.filter((tool) => findPattern(`${tool.name} ${tool.description}`, attrs.match).start !== -1) : pool;
    if (hits.length === 0) {
      return { missing: `no tool matches${attrs.match ? ` match="${attrs.match}"` : ""} in the ${scope} tool set (${active.length} active: ${active.slice(0, 12).join(", ")})` };
    }
    if (attrs.all === "true") return { value: hits.slice(0, MAX_LIST_ITEMS).map((tool) => `${tool.name}${tool.description ? ` - ${tool.description.slice(0, 120)}` : ""}`).join("\n") };
    const ordinal = Number(attrs.index ?? "1") || 1;
    const tool = hits[ordinal - 1];
    if (!tool) return { missing: `${hits.length} tool${hits.length === 1 ? "" : "s"} matched; index="${ordinal}" resolves to nothing` };
    if ((attrs.part ?? "name") === "description") return { value: tool.description || `${tool.name} has no description` };
    return { value: tool.name };
  };

  const resolveRepoTag = (attrs: Record<string, string>, cwd: string): { value?: string; missing?: string } => {
    const part = (attrs.part ?? "root").toLowerCase();
    const args = part === "branch" ? ["rev-parse", "--abbrev-ref", "HEAD"]
      : part === "head" ? ["rev-parse", "--short", "HEAD"]
      : part === "remote" ? ["remote", "get-url", "origin"]
      : part === "dirty" ? ["status", "--porcelain"]
      : ["rev-parse", "--show-toplevel"];
    const out = gitText(args, cwd);
    if (out === undefined) return { missing: `git ${args.join(" ")} said nothing in ${cwd}${part === "remote" ? " (no origin remote?)" : " (not a git repository?)"}` };
    if (part === "dirty") return { value: out.split("\n").filter(Boolean).length === 0 ? "clean" : `${out.split("\n").filter(Boolean).length} changed files` };
    return { value: out.split("\n")[0] };
  };

  const resolveSessionTag = (attrs: Record<string, string>, ctx: ExtensionContext | undefined, cwd: string): { value?: string; missing?: string } => {
    const part = (attrs.part ?? "id").toLowerCase();
    const manager = (ctx as { sessionManager?: Record<string, unknown> } | undefined)?.sessionManager;
    const read = (name: string): string | undefined => {
      const fn = manager?.[name];
      if (typeof fn !== "function") return undefined;
      const value = (fn as () => unknown)();
      return typeof value === "string" && value ? value : undefined;
    };
    if (part === "model" || part === "modelid") return modelOf(ctx) ? { value: (ctx!.model as { id?: string }).id ?? "" } : { missing: "no model is selected in this session" };
    if (part === "provider") return modelOf(ctx) ? { value: (ctx!.model as { provider?: string }).provider ?? "" } : { missing: "no model is selected in this session" };
    if (part === "cwd") return { value: cwd };
    if (part === "os") return { value: `${platform()}-${arch()}` };
    if (part === "name") { const value = read("getSessionName"); return value ? { value } : { missing: "this session has no name" }; }
    if (part === "dir") { const value = read("getSessionDir"); return value ? { value } : { missing: "this session has no session directory" }; }
    if (part === "file") { const value = read("getSessionFile"); return value ? { value } : { missing: "this session has no session file" }; }
    const value = read("getSessionId");
    return value ? { value } : { missing: 'part="id|name|model|provider|cwd|os|dir|file" - the session id is not available here' };
  };

  const resolveHistoryTag = (attrs: Record<string, string>, ctx: ExtensionContext | undefined): { value?: string; missing?: string } => {
    const pattern = attrs.pattern ?? attrs.match;
    const calls = sessionCalls(ctx);
    const hits = pattern ? calls.filter((call) => findPattern(`${call.tool} ${call.command}`, pattern).start !== -1) : calls;
    if (hits.length === 0) return { missing: `no earlier tool call matches${pattern ? ` pattern="${pattern}"` : ""} (looked at ${calls.length} call${calls.length === 1 ? "" : "s"} in this session)` };
    const part = (attrs.part ?? "command").toLowerCase();
    const show = (call: CallRecord) => (part === "tool" ? call.tool : part === "args" || part === "all" ? JSON.stringify({ tool: call.tool, command: call.command }) : call.command);
    if (attrs.all === "true") return { value: hits.slice(0, MAX_LIST_ITEMS).map((call) => `${call.tool}: ${show(call).slice(0, 200)}`).join("\n") };
    const ordinal = Number(attrs.index ?? "1") || 1;
    const hit = hits[ordinal - 1];
    if (!hit) return { missing: `${hits.length} earlier call${hits.length === 1 ? "" : "s"} matched; index="${ordinal}" resolves to nothing (index="1" is the most recent)` };
    return { value: show(hit).slice(0, MAX_REF_VALUE_CHARS) };
  };

  const resolveResultTag = (attrs: Record<string, string>, ctx: ExtensionContext | undefined): { value?: string; missing?: string } => {
    const pattern = attrs.pattern ?? attrs.match;
    const results = sessionResults(ctx);
    const scoped = attrs.error === "true" ? results.filter((result) => result.error) : results;
    const hits = pattern
      ? scoped.filter((result) => findPattern(result.text, pattern).start !== -1)
      : scoped;
    if (hits.length === 0) return { missing: `no earlier tool result matches${pattern ? ` pattern="${pattern}"` : ""} (looked at ${scoped.length} result${scoped.length === 1 ? "" : "s"}${attrs.error === "true" ? ", errors only" : ""})` };
    if (attrs.all === "true") {
      return { value: hits.slice(0, 5).map((result) => {
        const found = pattern ? findPattern(result.text, pattern) : { start: 0, end: 0 };
        return `[${result.tool}] ${windowAround(result.text, Math.max(0, found.start), Math.max(0, found.end), 120)}`;
      }).join("\n") };
    }
    const ordinal = Number(attrs.index ?? "1") || 1;
    const hit = hits[ordinal - 1];
    if (!hit) return { missing: `${hits.length} earlier results matched; index="${ordinal}" resolves to nothing (index="1" is the most recent)` };
    if ((attrs.part ?? "text") === "tool") return { value: hit.tool };
    if (attrs.full === "true") return { value: hit.text.slice(0, MAX_REF_VALUE_CHARS) };
    const radius = Math.min(2000, Math.max(40, Number(attrs.context ?? 240) || 240));
    const found = pattern ? findPattern(hit.text, pattern) : { start: 0, end: 0 };
    return { value: pattern ? windowAround(hit.text, found.start, found.end, radius) : hit.text.slice(0, MAX_REF_VALUE_CHARS) };
  };

  const resolveEnvTag = (attrs: Record<string, string>): { value?: string; missing?: string } => {
    const name = attrs.name ?? attrs.var;
    if (!name) return { missing: '<pi-env /> needs name="HF_ENDPOINT"' };
    const value = process.env[name];
    if (typeof value === "string" && value) return { value: value.slice(0, MAX_REF_VALUE_CHARS) };
    if (attrs.default !== undefined) return { value: attrs.default };
    return { missing: `process.env.${name} is not set in this session` };
  };

  const resolveSkillTag = (attrs: Record<string, string>, cwd: string): { value?: string; missing?: string } => {
    const name = attrs.name;
    if (!name) return { missing: '<pi-skill /> needs name="lilypond-music"' };
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return { missing: `name="${name}" is not a skill name` };
    const roots = [
      ...config.skillRoots.map(expandHome),
      join(cwd, ".pi", "skills"),
      join(homedir(), ".pi", "agent", "skills"),
      join(homedir(), ".agents", "skills"),
      join(homedir(), ".claude", "skills"),
    ];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      // <root>/<name>/SKILL.md, <root>/<group>/<name>/SKILL.md, or <root>/<name>.md
      const direct = [join(root, name, "SKILL.md"), join(root, `${name}.md`)];
      for (const candidate of direct) if (existsSync(candidate)) return { value: candidate };
      let groups: string[];
      try {
        groups = readdirSync(root);
      } catch {
        continue;
      }
      for (const group of groups) {
        const nested = join(root, group, name, "SKILL.md");
        if (existsSync(nested)) return { value: nested };
      }
    }
    return { missing: `no skill "${name}" found under ${roots.filter(existsSync).join(", ") || "any skill directory"} - add a root with skillRoots in the config` };
  };

  // --- variables the agent sets for itself ---------------------------------------------------------
  type StoredVar = { value: string; source: string; at: number };
  const varStore = new Map<string, StoredVar>(
    Object.entries(config.vars).map(([key, value]) => [key, { value, source: "config", at: Date.now() }]),
  );
  const usedIds = new Set<string>();

  const newVarId = (): string => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const id = `v${Math.random().toString(36).slice(2, 7)}`;
      if (!usedIds.has(id)) {
        usedIds.add(id);
        return id;
      }
    }
    const id = `v${Date.now().toString(36)}`;
    usedIds.add(id);
    return id;
  };

  /** Named variables win over anonymous captures: the oldest capture is dropped before a name is refused. */
  const autoEntries = (): Array<{ id: string; at: number }> =>
    [...varStore.entries()]
      .filter(([, entry]) => entry.source.startsWith("<"))
      .map(([id, entry]) => ({ id, at: entry.at }))
      .sort((a, b) => a.at - b.at);

  const makeRoom = (keepName: boolean): boolean => {
    if (varStore.size < MAX_VARS) return true;
    const autos = autoEntries();
    if (keepName && autos.length > 0) {
      varStore.delete(autos[0]!.id);
      return true;
    }
    return false;
  };

  /** Every tag that resolves is remembered, so its result can be cited again by id. */
  const captureVar = (value: string, attrs: Record<string, string>, source: string): string => {
    const requested = attrs.id;
    const explicit = requested && /^[A-Za-z0-9_.-]{1,40}$/.test(requested) ? requested : undefined;
    let id = explicit;
    if (!id) {
      const autos = autoEntries();
      if (autos.length >= MAX_AUTO_VARS) varStore.delete(autos[0]!.id);
      id = newVarId();
    } else if (!varStore.has(id) && !makeRoom(true)) return "";
    varStore.set(id, { value: value.slice(0, MAX_REF_VALUE_CHARS), source, at: Date.now() });
    usedIds.add(id);
    return id;
  };
  const projectVarFiles = new Set<string>();

  const projectVarPath = (cwd: string): string => join(cwd, ".pi", VAR_FILE_NAME);

  const loadProjectVars = (cwd: string): void => {
    const path = projectVarPath(cwd);
    if (projectVarFiles.has(path)) return;
    projectVarFiles.add(path);
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      for (const [key, value] of Object.entries(raw)) {
        if (varStore.has(key)) continue;
        if (typeof value === "string") varStore.set(key, { value, source: "project", at: 0 });
        else if (value && typeof value === "object") {
          const entry = value as { value?: unknown; source?: unknown };
          if (typeof entry.value === "string") varStore.set(key, { value: entry.value, source: typeof entry.source === "string" ? entry.source : "project", at: 0 });
        }
      }
    } catch {
      // no project file yet
    }
  };

  const saveProjectVars = (cwd: string): void => {
    const path = projectVarPath(cwd);
    try {
      const stored: Record<string, string> = {};
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        for (const [key, value] of Object.entries(raw)) if (typeof value === "string") stored[key] = value;
      }
      for (const [key, entry] of varStore) stored[key] = { value: entry.value, source: entry.source };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(stored, null, 2) + "\n", "utf8");
      projectVarFiles.add(path);
    } catch {
      // a read-only working directory is not a reason to fail the call
    }
  };

  const varNames = (): string[] => [...varStore.keys()].reverse();

  const resolveVarTag = (attrs: Record<string, string>, cwd: string): { value?: string; missing?: string } => {
    const id = attrs.id ?? attrs.var ?? attrs.name;
    if (!id) return { missing: '<pi-var /> needs id="mini" (and value="…" to define it)' };
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(id)) return { missing: `id="${id}" is not a variable id (letters, digits, . _ -, up to 40)` };
    if (attrs.id === undefined && (attrs.var || attrs.name)) return { missing: `<pi-var ${attrs.var ? "var" : "name"}="${id}" /> - the attribute is id="…" now` };
    if (attrs.unset === "true") {
      varStore.delete(id);
      return { value: "" };
    }
    if (attrs.value !== undefined) {
      if (!varStore.has(id) && !makeRoom(true)) return { missing: `${varStore.size} variables are already defined; unset one before adding id="${id}"` };
      const previous = varStore.get(id);
      varStore.set(id, {
        value: (attrs.append === "true" && previous ? `${previous.value}\n${attrs.value}` : attrs.value).slice(0, MAX_REF_VALUE_CHARS),
        source: previous?.source ?? "pi-var",
        at: Date.now(),
      });
      if (attrs.persist === "true") saveProjectVars(cwd);
      return { value: varStore.get(id)!.value };
    }
    loadProjectVars(cwd);
    const stored = varStore.get(id);
    if (stored === undefined) {
      const known = varNames();
      return { missing: `no variable id="${id}" is defined${known.length > 0 ? ` - defined: ${known.slice(0, 12).join(", ")}` : ' yet (write <pi-var id="mini" value="…" /> or give any tag an id="…")'}` };
    }
    if (attrs.part === "length") return { value: String(stored.value.length) };
    if (attrs.part === "source") return { value: stored.source };
    return { value: stored.value };
  };

  const resolveVarsTag = (): { value?: string; missing?: string } => {
    loadProjectVars(process.cwd());
    const ids = varNames();
    if (ids.length === 0) return { missing: 'no variables yet - give any tag an id="…" or write <pi-var id="mini" value="ssh macminister.local" />' };
    return {
      value: ids
        .map((id) => {
          const entry = varStore.get(id)!;
          return `${id} = ${entry.value.slice(0, 120).replace(/\n/g, " ⏎ ")}  (from ${entry.source})`;
        })
        .join("\n"),
    };
  };

  const depthOf = (_attrs: Record<string, string>): number => 0;

  type DirectRequest = {
    kind: "number" | "regex" | "date" | "file" | "task" | "tool" | "repo" | "session" | "history" | "result" | "env" | "skill" | "var" | "vars";
    attrs: Record<string, string>;
  };

  const resolveBuiltinElement = (tag: string, attrs: Record<string, string>): { token?: string; error?: string; direct?: DirectRequest } => {
    switch (tag) {
      case "ref": {
        // Canonical: <ref type="url" index="-1" /> - explicit about what and which message.
        const type = (attrs.type ?? "").toLowerCase();
        // offset = which message (-1 is the most recent), index = which entry inside that message.
        if (type === "date") return { direct: { kind: "date", attrs } };
        const offset = attrs.offset ?? attrs.message ?? "-1";
        if (!/^-?\d+$/.test(offset)) return { error: `<pi-ref type="${type}" offset="${offset}" /> - offset must be a message offset, negative to count back from the most recent (-1)` };
        const ordinal = attrs.index ?? "";
        if (type === "url" || type === "path") return { token: `u${offset}.${type}${ordinal}` };
        if (type === "line") return { token: `u${offset}.line${ordinal || "1"}` };
        if (type === "text" || type === "message" || type === "full") return { token: `u${offset}.text` };
        if (type === "number") return { direct: { kind: "number", attrs } };
        if (type === "regex") return { direct: { kind: "regex", attrs } };
        if (type === "tag" || type === "config" || type === "hook") {
          return { error: `<pi-ref type="${type}" /> no longer exists - a tag the user defined is written as its own element, <${TAG_PREFIX}${attrs.name ?? "name"} />` };
        }
        if (attrs.u || attrs.date || attrs.name || attrs.ref) {
          return { error: '<pi-ref ... /> takes type="url|path|line|text|number|regex|date" with offset/index/pattern/format' };
        }
        return { error: '<pi-ref ... /> needs type="url|path|line|text|number|regex|date"' };
      }
      case "date":
        return { direct: { kind: "date", attrs } };
      case "file":
        return { direct: { kind: "file", attrs } };
      case "task":
        return { direct: { kind: "task", attrs } };
      case "tool":
        return { direct: { kind: "tool", attrs } };
      case "tools":
        // The plural spelling lists them all.
        return { direct: { kind: "tool", attrs: { all: "true", ...attrs } } };
      case "repo":
        return { direct: { kind: "repo", attrs } };
      case "session":
        return { direct: { kind: "session", attrs } };
      case "history":
        return { direct: { kind: "history", attrs } };
      case "result":
        return { direct: { kind: "result", attrs } };
      case "env":
        return { direct: { kind: "env", attrs } };
      case "skill":
        return { direct: { kind: "skill", attrs } };
      case "var":
        return { direct: { kind: "var", attrs } };
      case "vars":
        return { direct: { kind: "vars", attrs } };
      default:
        return { error: `unknown reference element <${tag}>` };
    }
  };


  type ExpandOutcome = { text: string; used: string[]; missing: string[] };

  async function expandText(text: string, depth: number, ctx: ExtensionContext | undefined): Promise<ExpandOutcome> {
    const used: string[] = [];
    const missing: string[] = [];
    type Candidate = { start: number; end: number; token?: string; spec?: TagSpec; direct?: DirectRequest; tag?: string; attrs: Record<string, string>; error?: string };
    const candidates: Candidate[] = [];

    if (elementScanner && text.includes("<")) {
      elementScanner.lastIndex = 0;
      for (const match of text.matchAll(elementScanner)) {
        const start = match.index ?? 0;
        const attrs = parseAttrs(match[2] ?? "");
        const written = match[1] ?? "";
        const spec = config.tags[written.startsWith(TAG_PREFIX) ? written.slice(TAG_PREFIX.length) : written];
        if (spec && spec.kind !== "builtin") {
          candidates.push({ start, end: start + match[0].length, spec, tag: written, attrs });
          continue;
        }
        const request = resolveBuiltinElement(written.startsWith(TAG_PREFIX) ? written.slice(TAG_PREFIX.length) : written, attrs);
        candidates.push({ start, end: start + match[0].length, attrs, tag: written, token: request.token, error: request.error, direct: request.direct });
      }
    }

    for (const entry of tagPatterns) {
      entry.regex.lastIndex = 0;
      for (const match of text.matchAll(entry.regex)) {
        const start = match.index ?? 0;
        const attrs: Record<string, string> = { ...(match.groups ?? {}) };
        match.slice(1).forEach((value, position) => {
          if (typeof value === "string") attrs[String(position + 1)] = value;
        });
        candidates.push({ start, end: start + match[0].length, spec: entry.spec, attrs });
      }
    }

    if (candidates.length === 0) return { text, used, missing };
    candidates.sort((a, b) => a.start - b.start);

    let out = "";
    let cursor = 0;
    for (const candidate of candidates) {
      if (candidate.start < cursor) continue; // inside a replacement already made
      const original = text.slice(candidate.start, candidate.end);
      out += text.slice(cursor, candidate.start);
      cursor = candidate.end;
      if (candidate.error) {
        out += original;
        missing.push(candidate.error);
        continue;
      }
      const resolved = candidate.spec
        ? await resolveSpec(candidate.spec, candidate.attrs, ctx)
        : candidate.direct
          ? await resolveDirect(candidate.direct, candidate.attrs, ctx, depth)
          : resolveUserMessagePart(candidate.token ?? "");
      if (resolved.value !== undefined) {
        out += resolved.value;
        used.push(original);
        // Whatever a tag resolved to is remembered, so `id="…"` or <pi-vars /> can cite it again.
        const bare = (candidate.tag ?? "").startsWith(TAG_PREFIX) ? (candidate.tag as string).slice(TAG_PREFIX.length) : candidate.tag ?? "";
        if (bare !== "var" && bare !== "vars") captureVar(resolved.value, candidate.attrs, `<${candidate.tag}>`);
      } else {
        out += original;
        if (resolved.missing) missing.push(resolved.missing);
      }
    }
    out += text.slice(cursor);
    return { text: out, used, missing };
  }

  async function expandValue(value: unknown, depth: number, ctx: ExtensionContext | undefined): Promise<{ value: unknown; used: string[]; missing: string[] }> {
    const used: string[] = [];
    const missing: string[] = [];
    if (typeof value === "string") {
      const result = await expandText(value, depth, ctx);
      return { value: result.text, used: result.used, missing: result.missing };
    }
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) {
        const result = await expandValue(item, depth, ctx);
        items.push(result.value);
        used.push(...result.used);
        missing.push(...result.missing);
      }
      return { value: items, used, missing };
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const result = await expandValue(item, depth, ctx);
        out[key] = result.value;
        used.push(...result.used);
        missing.push(...result.missing);
      }
      return { value: out, used, missing };
    }
    return { value, used, missing };
  }

  const refIndexLines = (): string[] => {
    if (config.refIndexSize === 0) return [];
    const withLinks = userMessages.filter((message) => message.urls.length > 0 || message.paths.length > 0);
    const total = userMessages.length;
    return withLinks.slice(-config.refIndexSize).flatMap((message) => {
      // Relative indices, because "-1 is the last thing you pasted" stays true as the session grows.
      const back = -(total - message.n + 1);
      const lines: string[] = [];
      message.urls.slice(0, 2).forEach((url, position) => {
        lines.push(`<${TAG_PREFIX}ref type="url" offset="${back}"${position === 0 ? "" : ` index="${position + 1}"`} /> = ${url.slice(0, MAX_INDEX_LINE_CHARS)}`);
      });
      message.paths.slice(0, 1).forEach((path) => lines.push(`<${TAG_PREFIX}ref type="path" offset="${back}" /> = ${path.slice(0, MAX_INDEX_LINE_CHARS)}`));
      return lines;
    });
  };

  const userTagSummaries = (): string[] =>
    Object.values(config.tags).map((spec) => {
      const attrs = spec.attrs && spec.attrs.length > 0 ? spec.attrs.map((key) => `${key}="…"`).join(" ") : "";
      const how = spec.kind === "value" ? `fixed text${spec.value ? `: ${spec.value.slice(0, 80)}` : ""}`
        : spec.kind === "template" ? `template ${String(spec.template).slice(0, 120)}`
        : spec.kind === "js" ? "JavaScript you defined"
        : `hook ${spec.hook ?? spec.name}`;
      const pattern = spec.pattern ? ` matched by ${spec.pattern}` : "";
      const described = spec.description ? `${spec.description} - ` : "";
      return `${described}<${TAG_PREFIX}${spec.name}${attrs ? ` ${attrs}` : ""} /> (${how})`;
    });

  const modelMatches = (ctx: ExtensionContext): boolean => {
    if (config.models.length === 0) return true;
    const haystack = (modelOf(ctx) ?? "").toLowerCase();
    return config.models.some((needle) => needle.toLowerCase() && haystack.includes(needle.toLowerCase()));
  };

  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled) return;
    await hooksReady;
    const userEvent = event as { messageType?: string; prompt?: string };
    if (userEvent.messageType === "user" && typeof userEvent.prompt === "string") recordUser(userEvent.prompt);

    const options = (event as { systemPromptOptions?: { promptGuidelines?: string[] } }).systemPromptOptions;
    if (!options) return;
    const disabled = new Set(config.disableTags);
    const guidelines: string[] = [
      "Inline tags resolve to real text at the moment the call runs - use them instead of retyping URLs, paths, task ids, tool names, or dates you have already seen.",
      ...BUILTIN_TAGS.filter((name) => !disabled.has(name) && BUILTIN_GUIDE[name]).map((name) => BUILTIN_GUIDE[name]!),
    ];
    const index = refIndexLines();
    if (index.length > 0) guidelines.push(`References available now: ${index.join(" · ")}`);
    const own = userTagSummaries();
    if (own.length > 0) guidelines.push(`Your own tags: ${own.join(" · ")}`);
    if (config.promptHook && hooks.has(config.promptHook)) {
      const custom = await callHook(config.promptHook, { attrs: {}, model: modelOf(ctx), cwd: process.cwd(), userMessages: userMessages.length });
      if (custom) guidelines.push(`User prompt hook ${config.promptHook}: ${custom.slice(0, MAX_GUIDELINE_CHARS)}`);
    }
    // The reference rules are cheap and useful for every model; the model gate only hides them where the
    // user does not want the extra tokens at all.
    if (modelMatches(ctx)) options.promptGuidelines = [...(options.promptGuidelines ?? []), ...guidelines];
  });

  pi.on("message_end", async (event) => {
    if (!enabled || !config.expandAssistant) return;
    await hooksReady;
    const message = event.message as { role?: string; content?: unknown } | undefined;
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return;
    let changed = false;
    const used: string[] = [];
    const content: unknown[] = [];
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block && block.type === "text" && typeof block.text === "string" && (block.text.includes("<") || block.text.includes("@"))) {
        const result = await expandText(block.text, 0, undefined);
        if (result.used.length > 0) {
          changed = true;
          used.push(...result.used);
          content.push({ ...block, text: result.text });
          continue;
        }
      }
      if (block && block.type === "toolCall" && block.arguments) {
        const result = await expandValue(block.arguments, 0, undefined);
        if (result.used.length > 0) {
          changed = true;
          used.push(...result.used);
          content.push({ ...block, arguments: result.value });
          continue;
        }
      }
      content.push(block);
    }
    if (!changed) return;
    note(`assistant message: expanded ${[...new Set(used)].join(", ")}`);
    return { message: { ...message, content } };
  });

  pi.on("input", async (event) => {
    if (!enabled || !config.expandUserInput) return;
    await hooksReady;
    const text = typeof event.text === "string" ? event.text : "";
    if (!text.includes("<") && !text.includes("@")) return;
    const result = await expandText(text, 0, undefined);
    if (result.used.length === 0) return;
    note(`your input: expanded ${[...new Set(result.used)].join(", ")}`);
    return { action: "transform", text: result.text, images: event.images };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled || !config.expandToolCalls) return;
    await hooksReady;
    const input = event.input as Record<string, unknown> | undefined;
    if (!input || typeof input !== "object") return;
    const result = await expandValue(input, 0, ctx);
    for (const [key, value] of Object.entries(result.value as Record<string, unknown>)) input[key] = value;
    if (result.used.length > 0) note(`${event.toolName}: expanded ${[...new Set(result.used)].join(", ")}`);
    if (result.missing.length > 0) {
      const own = Object.keys(config.tags).slice(0, 10);
      return {
        block: true,
        reason:
          `A reference the call used could not be resolved: ${[...new Set(result.missing)].join("; ")}. ` +
          `User messages are addressed as <pi-ref type="url" offset="-1" /> (most recent) … offset="-${userMessages.length}"; ` +
          `dates are <pi-date value="date|datetime|time|today|yesterday|tomorrow|week|year" offset="+3d|-2h|+10m|+1w" />` +
          (own.length > 0 ? `; your tags: ${own.map((name) => `<${name} />`).join(", ")}` : "") +
          ". Fix the reference or write the text out in full.",
      };
    }
    return undefined;
  });

  pi.registerCommand("refs", {
    description: "List the references that resolve right now",
    handler: async (_args, ctx) => {
      await hooksReady;
      const lines = refIndexLines();
      const own = [...userTagSummaries(), ...[...hooks.keys()].filter((name) => !Object.values(config.tags).some((spec) => (spec.hook ?? spec.name) === name)).map((name) => `<pi-ref type="tag" name="${name}" /> (hook only)`)];
      ctx.ui.notify(
        [
          `user messages: ${userMessages.length} → <pi-ref type="url" offset="-1" /> is the newest, offset="-${userMessages.length}" the oldest`,
          lines.length > 0 ? `links and paths seen:\n${lines.map((line) => `  ${line}`).join("\n")}` : "no URLs or paths pasted yet",
          own.length > 0 ? `yours:\n${own.map((line) => `  ${line}`).join("\n")}` : "no tags or hooks configured",
          `dates: <pi-date value="date|datetime|time|today|yesterday|tomorrow|week|year" offset="+3d|-2h|+10m|+1w" /> (or <pi-ref type="date" ... />)`,
          ...BUILTIN_TAGS.filter((name) => !config.disableTags.includes(name)).map((name) => BUILTIN_GUIDE[name] ?? `<${TAG_PREFIX}${name} />`),
          [...loaded.problems, ...hookProblems].length > 0
            ? `problems: ${[...loaded.problems, ...hookProblems].join("; ")}`
            : `hooks ok (${hooks.size} from ${hooksPath})`,
        ].join("\n"),
        [...loaded.problems, ...hookProblems].length > 0 ? "warning" : "info",
      );
    },
  });

  pi.registerCommand("inline-tags", {
    description: "Inspect or toggle pi-inline-tags: status | on | off",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase() || "status";
      if (sub === "on" || sub === "off") enabled = sub === "on";
      const recent = applied.slice(-5).map((line) => `  ${line}`).join("\n");
      const problems = [...loaded.problems, ...hookProblems];
      ctx.ui.notify(
        [
          `inline-tags=${enabled ? "on" : "off"} · expand: toolCalls=${config.expandToolCalls ? "on" : "off"} assistant=${config.expandAssistant ? "on" : "off"} input=${config.expandUserInput ? "on" : "off"} · messages=${userMessages.length} · tags=${tagNames.length}+${tagPatterns.length}pattern · hooks=${hooks.size} · promptHook=${config.promptHook || "none"}`,
          `model gate matched now=${modelMatches(ctx) ? "yes" : "no"} · config=${loaded.path} · hooksFile=${hooksPath}`,
          problems.length > 0 ? `problems: ${problems.join("; ")}` : "config ok",
          recent ? `recent expansions:\n${recent}` : "no expansions applied yet",
        ].join("\n"),
        problems.length > 0 ? "warning" : "info",
      );
    },
  });
}
