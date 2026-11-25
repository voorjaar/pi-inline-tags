/**
 * pi-inline-tags - let the agent cite what you pasted instead of retyping it.
 *
 * Why this exists: a model that re-types a link, path, or id the human pasted gets it wrong often enough to
 * be its own failure family - 404'd screenshot links, mangled ids, off-by-one paths. Every one of those
 * mistakes happens at the moment the model copies the string, and the correct string is already sitting in
 * the conversation. So this extension remembers the conversation's own inputs and resolves a small inline
 * marker to the real text:
 *
 *   <pi-ref type="url" index="-1" />         the first URL in the most recent message (-2 is the one before)
 *   <pi-ref type="url" index="-1" number="2" />  its second URL
 *   <pi-ref type="path" index="7" />         the first path in message 7
 *   <pi-ref type="line" index="-1" number="3" /> its third non-empty line
 *   <pi-ref type="text" index="-1" />        the whole message, verbatim
 *   <pi-date value="date" offset="+3d" />    a computed date
 *   <pi-pr n="12" />                        a tag you defined in JSON
 *
 * `pi-ref` and `pi-date` are the only built-in tags. Every other tag name is yours, declared in `tags` by its
 * bare name (`"pr"` is written `<pi-pr />`), and its text can be a literal, a template, a hook, or JavaScript
 * you wrote in the JSON itself. The `pi-` prefix exists so a tag is never confused with an HTML element; the
 * bare spelling still works.
 *
 * A tag rather than an `@token`, because tool arguments and prose are full of `@scope/package`, email
 * addresses and npm names, and a reference should never be ambiguous with one of those. The `@` shorthand
 * (`@u7.url`, `@date+3d`, `@mini`) still works while `atSyntax` is on.
 *
 * Config: `<agentDir>/pi-inline-tags.json` (override with PI_INLINE_TAGS_CONFIG):
 *   {
 *     "enabled": true,
 *     "models": ["qwen3.8"],                  // guidance only; resolution always runs when enabled
 *     "refIndexSize": 6,                      // how many pasted links to name in the prompt
 *     "atSyntax": true,
 *     "expandToolCalls": true,
 *     "expandAssistant": true,
 *     "expandUserInput": true,
 *     "promptHook": "morning_note",           // a hook whose text is appended to the system prompt
 *     "hookTimeoutMs": 2000,
 *     "hookCacheSeconds": 5,
 *     "disableTags": ["date"],                // drop a default tag
 *     "tags": {
 *       "host":   { "value": "ssh macminister.local" },
 *       "pr":     { "template": "https://github.com/voorjaar/v1gate/pull/{n}", "attrs": ["n"] },
 *       "shot":   { "hook": "screenshot", "attrs": ["days"] },
 *       "due":    { "js": "return ctx.date('date', '+3d')" },
 *       "ticket": { "pattern": "\\[\\[ticket\\s+(\\d+)\\]\\]", "template": "https://tracker.local/t/{1}" }
 *     }
 *   }
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

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const USER_REF = /^u(-?\d+)(?:\.(url(\d*)|path|line(\d+)|text))?$/;
const DATE_REF = /^(date|datetime|time|today|yesterday|tomorrow|week|year)([+-]\d+([mhdw]))?$/i;
const REF_TOKEN = /@([A-Za-z][A-Za-z0-9_.+-]*)/g;
const ELEMENT_ATTR = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const URL_PATTERN = /https?:\/\/[^\s"'`<>()\[\]]+/g;
const PATH_PATTERN = /(?:~|\/)[A-Za-z0-9_./-]{3,}/g;

/** The shipped defaults. `tags` in the config adds to them, `disableTags` removes from them. */
const TAG_PREFIX = "pi-";
const BUILTIN_TAGS = ["ref", "date"];

type TagSpec = {
  name: string;
  kind: "builtin" | "value" | "template" | "hook" | "js";
  value?: string;
  template?: string;
  hook?: string;
  js?: string;
  pattern?: string;
  attrs?: string[];
  source: "builtin" | "config" | "hooks";
};

/** What a `js` tag body may reach for. No require/import: the context carries what is useful. */
type TagContext = {
  name: string;
  attrs: Record<string, string>;
  type?: string;
  index?: string;
  modifier?: string;
  match?: string;
  model?: string;
  cwd: string;
  env: (name: string) => string | undefined;
  now: () => string;
  date: (kind?: string, offset?: string) => string;
  message: (index?: string, type?: string, number?: string) => string;
  userMessages: number;
};

type Config = {
  enabled: boolean;
  models: string[];
  refIndexSize: number;
  atSyntax: boolean;
  expandToolCalls: boolean;
  expandAssistant: boolean;
  expandUserInput: boolean;
  promptHook: string;
  hooksFile: string;
  hookTimeoutMs: number;
  hookCacheSeconds: number;
  disableTags: string[];
  tags: Record<string, TagSpec>;
};

const DEFAULT_CONFIG: Config = {
  enabled: true,
  models: [],
  refIndexSize: DEFAULT_REF_INDEX_SIZE,
  atSyntax: true,
  expandToolCalls: true,
  expandAssistant: true,
  expandUserInput: true,
  promptHook: "",
  hooksFile: "",
  hookTimeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
  hookCacheSeconds: DEFAULT_HOOK_CACHE_SECONDS,
  disableTags: [],
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

function expandHome(value: string): string {
  return value.replace(/^~(?=$\/)/, homedir());
}

function validTagName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(name);
}

/** One tag definition, validated. Returns undefined and reports the problem otherwise. */
function parseTag(rawName: string, raw: unknown): { spec?: TagSpec; problem?: string } {
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
  const code = entry.js ?? entry.code;
  if (code !== undefined) {
    if (typeof code !== "string") return { problem: `tag "${name}".js must be a JavaScript body string` };
    if (code.length > 8000) return { problem: `tag "${name}".js is longer than 8000 characters` };
    try {
      AsyncFunction("ctx", `"use strict";\n${code}`);
    } catch (error) {
      return { problem: `tag "${name}".js is not valid JavaScript: ${String(error)}` };
    }
    spec.kind = "js";
    spec.js = code;
    given.push("js");
  }
  if (given.length > 1) return { problem: `tag "${name}" sets ${given.join(" and ")}; use one of value, template, hook, js` };
  if (given.length === 0) spec.kind = "builtin";
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
  for (const key of ["atSyntax", "expandToolCalls", "expandAssistant", "expandUserInput"] as const) {
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
  if (raw.disableTags !== undefined) {
    if (Array.isArray(raw.disableTags) && raw.disableTags.every((value) => typeof value === "string")) config.disableTags = raw.disableTags as string[];
    else problems.push("disableTags must be an array of tag names");
  }
  if (raw.tags !== undefined) {
    if (!raw.tags || typeof raw.tags !== "object" || Array.isArray(raw.tags)) {
      problems.push("tags must be an object of name: definition");
    } else {
      const entries = Object.entries(raw.tags as Record<string, unknown>);
      if (entries.length > MAX_TAGS) problems.push(`tags has more than ${MAX_TAGS} entries`);
      for (const [name, definition] of entries.slice(0, MAX_TAGS)) {
        const result = parseTag(name, definition);
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

function linesOf(message: UserMessage): string[] {
  return message.text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

const MS_UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

function dateValue(kind: string, modifier?: string): string | undefined {
  const base = new Date();
  if (kind === "yesterday") base.setDate(base.getDate() - 1);
  if (kind === "tomorrow") base.setDate(base.getDate() + 1);
  if (modifier) {
    const match = /^([+-])(\d+)([mhdw])$/.exec(modifier);
    if (!match) return undefined;
    const amount = Number(match[2]) * (match[1] === "-" ? -1 : 1);
    base.setTime(base.getTime() + amount * (MS_UNITS[match[3] ?? "d"] ?? 0));
  }
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

async function loadHooks(path: string): Promise<{ hooks: Map<string, HookFn>; tags: TagSpec[]; problems: string[] }> {
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
        const result = parseTag(name, definition);
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
  const hooksReady = loadHooks(hooksPath).then((result) => {
    hooks = result.hooks;
    hookProblems.push(...result.problems);
    // Tags the hook file declares are merged in, so a JS file can define syntax too, not just values.
    for (const spec of result.tags) if (!config.tags[spec.name]) config.tags[spec.name] = spec;
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
    elementScanner = tagNames.length > 0 ? new RegExp(`<(${tagNames.join("|")})\\b([^>]*)\\/?>`, "g") : undefined;
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

  /** The built-in grammar: u7.url / date+3d / a configured name / a hook name. */
  const resolveToken = async (
    token: string,
    attrs: Record<string, string>,
    depth: number,
    ctx: ExtensionContext | undefined,
  ): Promise<{ value?: string; missing?: string }> => {
    const userMatch = USER_REF.exec(token);
    if (userMatch) {
      const requested = Number(userMatch[1]);
      const n = requested > 0 ? requested : userMessages.length + requested + 1;
      const message = userMessages[n - 1];
      const range = `this session has ${userMessages.length} user message${userMessages.length === 1 ? "" : "s"} (index="-1" is the most recent)`;
      if (!message || n < 1) return { missing: `index="${userMatch[1]}" points outside the conversation - ${range}` };
      // "url2" and "line3" carry their ordinal inside the part name.
      const rawPart = userMatch[2] ?? "";
      const part = rawPart.replace(/\d+$/, "");
      const ordinal = Number((rawPart.match(/\d+$/) ?? [])[0] || userMatch[3] || userMatch[4] || "1");
      if (!part || part === "text") return { value: message.text.trim().slice(0, MAX_REF_VALUE_CHARS) };
      if (part === "url") {
        const url = message.urls[ordinal - 1];
        return url ? { value: url } : { missing: `message ${n} has ${message.urls.length} URL${message.urls.length === 1 ? "" : "s"}, so number="${ordinal}" resolves to nothing` };
      }
      if (part === "path") {
        const found = message.paths[ordinal - 1];
        return found ? { value: found } : { missing: `message ${n} contains no path` };
      }
      const lineIndex = ordinal;
      const lines = linesOf(message);
      const line = lines[lineIndex - 1];
      return line ? { value: line } : { missing: `message ${n} has ${lines.length} non-empty line${lines.length === 1 ? "" : "s"}, not ${lineIndex}` };
    }

    const dateMatch = DATE_REF.exec(token);
    if (dateMatch) {
      const value = dateValue(dateMatch[1] ?? "date", dateMatch[2]);
      return value ? { value } : { missing: `"${token}" is not a date the extension knows. Offsets look like +3d, -2h, +10m, +1w.` };
    }

    const base = token.split(/[.+-]/)[0] ?? "";
    const suffix = token.slice(base.length);
    const spec = config.tags[base];
    if (spec && spec.kind !== "builtin") {
      const resolved = await resolveSpec(spec, { ...attrs, ...(suffix ? { suffix } : {}) }, ctx);
      if (resolved.value !== undefined && depth < MAX_REF_DEPTH) return { value: (await expandText(resolved.value, depth + 1, ctx)).text };
      return resolved;
    }
    if (hooks.has(base)) {
      const modifier = attrs.modifier ?? attrs.offset ?? suffix ?? undefined;
      const value = await callHook(base, { attrs, modifier, model: modelOf(ctx), cwd: process.cwd(), userMessages: userMessages.length });
      if (value === undefined) return {};
      if (depth < MAX_REF_DEPTH) return { value: (await expandText(value, depth + 1, ctx)).text };
      return { value };
    }
    return {};
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
      return value === undefined ? { missing: `hook "${spec.hook ?? spec.name}" returned nothing` } : { value };
    }
    if (spec.kind === "js") {
      const value = await runTagCode(spec, attrs, ctx);
      return value === undefined ? { missing: `tag <${spec.name}> js returned nothing (a body must return a string)` } : { value };
    }
    return { missing: `tag <${spec.name}> has no value, template, hook, or js` };
  };

  const tagFunctions = new Map<string, (ctx: TagContext) => Promise<unknown>>();

  const tagContextFor = (spec: TagSpec, attrs: Record<string, string>, ctx: ExtensionContext | undefined): TagContext => ({
    name: spec.name,
    attrs,
    type: attrs.type,
    index: attrs.index,
    modifier: attrs.modifier ?? attrs.offset,
    match: attrs.match,
    model: modelOf(ctx),
    cwd: process.cwd(),
    env: (name: string) => process.env[name],
    now: () => new Date().toISOString(),
    date: (kind = "date", offset?: string) => dateValue(kind, offset) ?? dateValue("date") ?? "",
    message: (index = "-1", type = "text", number?: string) => {
      const requested = Number(index);
      const n = Number.isFinite(requested) ? (requested > 0 ? requested : userMessages.length + requested + 1) : userMessages.length;
      const message = userMessages[n - 1];
      if (!message) return "";
      if (type === "url" || type === "path") return (type === "url" ? message.urls : message.paths)[Number(number ?? "1") - 1] ?? "";
      if (type === "line") return linesOf(message)[Number(number ?? "1") - 1] ?? "";
      return message.text.trim();
    },
    userMessages: userMessages.length,
  });

  const runTagCode = async (spec: TagSpec, attrs: Record<string, string>, ctx: ExtensionContext | undefined): Promise<string | undefined> => {
    let fn = tagFunctions.get(spec.name);
    if (!fn) {
      try {
        const compiled = AsyncFunction("ctx", `"use strict";\n${spec.js ?? ""}`) as (ctx: TagContext) => Promise<unknown>;
        tagFunctions.set(spec.name, compiled);
        fn = compiled;
      } catch (error) {
        note(`tag ${spec.name} js failed to compile: ${String(error)}`);
        return undefined;
      }
    }
    const cacheKey = `js:${spec.name}|${Object.entries(attrs).sort().join(",")}`;
    const hit = hookCache.get(cacheKey);
    if (hit && Date.now() - hit.at < config.hookCacheSeconds * 1000) return hit.value;
    const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), config.hookTimeoutMs));
    let outcome: unknown;
    try {
      outcome = await Promise.race([Promise.resolve(fn(tagContextFor(spec, attrs, ctx))).catch(() => undefined), timeout]);
    } catch {
      outcome = undefined;
    }
    if (typeof outcome !== "string" || !outcome.trim()) {
      note(`tag ${spec.name} js returned nothing`);
      return undefined;
    }
    const value = outcome.slice(0, MAX_REF_VALUE_CHARS);
    hookCache.set(cacheKey, { at: Date.now(), value });
    return value;
  };

  const depthOf = (_attrs: Record<string, string>): number => 0;

  const resolveBuiltinElement = (tag: string, attrs: Record<string, string>): { token?: string; error?: string } => {
    switch (tag) {
      case "ref": {
        // Canonical: <ref type="url" index="-1" /> - explicit about what and which message.
        const type = (attrs.type ?? "").toLowerCase();
        const index = attrs.index ?? attrs.n ?? attrs.message ?? "-1";
        if (!/^-?\d+$/.test(index)) return { error: `<ref type="${type}" index="${index}" /> - index must be a message number, or negative to count back from the most recent (-1)` };
        const number = attrs.number ?? attrs.ordinal ?? "";
        if (type === "url" || type === "path") return { token: `u${index}.${type}${number}` };
        if (type === "line") return { token: `u${index}.line${number || "1"}` };
        if (type === "text" || type === "message" || type === "full") return { token: `u${index}.text` };
        if (type === "date") return { token: `${attrs.value ?? "date"}${attrs.offset ?? ""}` };
        if (type === "tag" || type === "config") {
          const name = attrs.name ?? attrs.ref;
          if (!name) return { error: `<ref type="${type}" /> needs name="..."` };
          return { token: name };
        }
        if (type === "hook") {
          const name = attrs.name ?? attrs.ref;
          if (!name) return { error: '<ref type="hook" /> needs name="..."' };
          return { token: `${name}${attrs.modifier ?? attrs.offset ?? ""}` };
        }
        // Aliases, so the shorter shapes people reach for still work.
        if (attrs.u) return { token: `u${attrs.u.replace(/^u/, "")}` };
        if (attrs.date) return { token: attrs.date.replace(/^@/, "") };
        const name = attrs.name ?? attrs.ref;
        if (name) return { token: name };
        return { error: '<ref ... /> needs type="url|path|line|text|date|tag|hook" (or u="7.url", date="date+3d", name="mini")' };
      }
      case "date":
        return { token: `${attrs.value ?? attrs.kind ?? attrs.format ?? "date"}${attrs.offset ?? ""}` };
      default:
        return { error: `unknown reference element <${tag}>` };
    }
  };

  /** @ tokens are only references when they cannot be something else, so `@scope/pkg` stays alone. */
  const looksLikeRef = (inner: string): boolean => {
    if (USER_REF.test(inner) || DATE_REF.test(inner)) return true;
    const base = inner.split(/[.+-]/)[0] ?? "";
    return Boolean(config.tags[base]) || hooks.has(base);
  };

  type ExpandOutcome = { text: string; used: string[]; missing: string[] };

  async function expandText(text: string, depth: number, ctx: ExtensionContext | undefined): Promise<ExpandOutcome> {
    const used: string[] = [];
    const missing: string[] = [];
    type Candidate = { start: number; end: number; token?: string; spec?: TagSpec; attrs: Record<string, string>; error?: string };
    const candidates: Candidate[] = [];

    if (elementScanner && text.includes("<")) {
      elementScanner.lastIndex = 0;
      for (const match of text.matchAll(elementScanner)) {
        const start = match.index ?? 0;
        const attrs = parseAttrs(match[2] ?? "");
        const written = match[1] ?? "";
        const spec = config.tags[written.startsWith(TAG_PREFIX) ? written.slice(TAG_PREFIX.length) : written];
        if (spec && spec.kind !== "builtin") {
          candidates.push({ start, end: start + match[0].length, spec, attrs });
          continue;
        }
        const request = resolveBuiltinElement(written.startsWith(TAG_PREFIX) ? written.slice(TAG_PREFIX.length) : written, attrs);
        candidates.push({ start, end: start + match[0].length, attrs, token: request.token, error: request.error });
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

    if (config.atSyntax && text.includes("@")) {
      REF_TOKEN.lastIndex = 0;
      for (const match of text.matchAll(REF_TOKEN)) {
        const start = match.index ?? 0;
        const before = start > 0 ? text[start - 1] ?? "" : "";
        // `mail@u7` and `pkg/@u7` are not references.
        if (/[A-Za-z0-9_.:/@-]/.test(before)) continue;
        const inner = match[1] ?? "";
        if (!looksLikeRef(inner)) continue;
        candidates.push({ start, end: start + match[0].length, token: inner, attrs: {} });
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
        : await resolveToken(candidate.token ?? "", candidate.attrs, depth, ctx);
      if (resolved.value !== undefined) {
        out += resolved.value;
        used.push(original);
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
        lines.push(`<${TAG_PREFIX}ref type="url" index="${back}"${position === 0 ? "" : ` number="${position + 1}"`} /> = ${url.slice(0, MAX_INDEX_LINE_CHARS)}`);
      });
      message.paths.slice(0, 1).forEach((path) => lines.push(`<${TAG_PREFIX}ref type="path" index="${back}" /> = ${path.slice(0, MAX_INDEX_LINE_CHARS)}`));
      return lines;
    });
  };

  const userTagSummaries = (): string[] =>
    Object.values(config.tags).map((spec) => {
      const shape = spec.kind === "value" ? "value" : spec.kind === "template" ? `template ${spec.template}` : spec.kind === "js" ? "js" : `hook ${spec.hook ?? spec.name}`;
      const attrs = spec.attrs && spec.attrs.length > 0 ? ` attrs: ${spec.attrs.join(", ")}` : "";
      const pattern = spec.pattern ? ` pattern: ${spec.pattern}` : "";
      return `<${TAG_PREFIX}${spec.name}${spec.attrs && spec.attrs.length > 0 ? " " + spec.attrs.map((key) => `${key}="…"`).join(" ") : ""} /> → ${shape}${attrs}${pattern}`;
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
    const guidelines: string[] = [
      'Use inline reference tags instead of retyping what the user pasted: <pi-ref type="url" index="-1" /> is the first URL in the most recent message (index="-2" is the one before), <pi-ref type="path" index="-1" /> its first path, <pi-ref type="line" index="-1" number="3" /> its third line, <pi-ref type="text" index="-1" /> the whole message, <pi-date value="date" offset="+3d" /> a computed date, <pi-pr n="12" /> a tag the user defined in config.',
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

  pi.on("tool_call", async (event) => {
    if (!enabled || !config.expandToolCalls) return;
    await hooksReady;
    const input = event.input as Record<string, unknown> | undefined;
    if (!input || typeof input !== "object") return;
    const result = await expandValue(input, 0, undefined);
    for (const [key, value] of Object.entries(result.value as Record<string, unknown>)) input[key] = value;
    if (result.used.length > 0) note(`${event.toolName}: expanded ${[...new Set(result.used)].join(", ")}`);
    if (result.missing.length > 0) {
      const own = Object.keys(config.tags).slice(0, 10);
      return {
        block: true,
        reason:
          `A reference the call used could not be resolved: ${[...new Set(result.missing)].join("; ")}. ` +
          `User messages are addressed as <pi-ref type="url" index="-1" /> (most recent) … index="-${userMessages.length}"; ` +
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
          `user messages: ${userMessages.length} → <pi-ref type="url" index="-1" /> is the newest, index="-${userMessages.length}" the oldest`,
          lines.length > 0 ? `links and paths seen:\n${lines.map((line) => `  ${line}`).join("\n")}` : "no URLs or paths pasted yet",
          own.length > 0 ? `yours:\n${own.map((line) => `  ${line}`).join("\n")}` : "no tags or hooks configured",
          `dates: <pi-date value="date|datetime|time|today|yesterday|tomorrow|week|year" offset="+3d|-2h|+10m|+1w" /> (or <pi-ref type="date" ... />)`,
          `defaults on: ${BUILTIN_TAGS.map((name) => `<${TAG_PREFIX}${name} />`).join(", ")}${config.disableTags.length > 0 ? ` (off: ${config.disableTags.join(", ")})` : ""} · @ shorthand ${config.atSyntax ? "on" : "off"}`,
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
          `inline-tags=${enabled ? "on" : "off"} · expand: toolCalls=${config.expandToolCalls ? "on" : "off"} assistant=${config.expandAssistant ? "on" : "off"} input=${config.expandUserInput ? "on" : "off"} · messages=${userMessages.length} · tags=${tagNames.length}+${tagPatterns.length}pattern · hooks=${hooks.size} · promptHook=${config.promptHook || "none"} · atSyntax=${config.atSyntax ? "on" : "off"}`,
          `model gate matched now=${modelMatches(ctx) ? "yes" : "no"} · config=${loaded.path} · hooksFile=${hooksPath}`,
          problems.length > 0 ? `problems: ${problems.join("; ")}` : "config ok",
          recent ? `recent expansions:\n${recent}` : "no expansions applied yet",
        ].join("\n"),
        problems.length > 0 ? "warning" : "info",
      );
    },
  });
}
