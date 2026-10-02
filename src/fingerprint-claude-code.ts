// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// The fingerprint parts of a Claude Code agent. Read only in the SessionStart
// and SessionEnd hooks, from the folder the hook payload names, and kept as
// the claude-code source in fingerprint-sources.json, which sync and run
// read from any folder. Hashes come out of here, and the one model id as
// text, the model name sync declares (VOU-566), less an ARN's account and
// region (modelNameOf). Server and tool names and the version stay on this
// machine.
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { FINGERPRINT_NOT_DECLARED, partHash } from '@sealkeeper/schema';
import { claudeConfigDir } from './claude-code-settings.js';
import type { Paths } from './config.js';
import { readEnv } from './env.js';
import {
  type CapturedPart,
  type CapturedParts,
  type ObservedParts,
  replaceSource,
} from './fingerprint.js';
import {
  findPackageVersion,
  frameworkContent,
  isVersion,
  linesContent,
  modelSetContent,
} from './fingerprint-content.js';
import { modelNameOf, toolNameOf } from './names.js';

export type ClaudeCodeWhere = {
  // The folder Claude Code runs in, the hook payload's cwd. The project is
  // the nearest folder at or above it with .mcp.json or .claude, see
  // projectDir.
  cwd: string;
  env: NodeJS.ProcessEnv;
  // ~/.claude, or CLAUDE_CONFIG_DIR, when unset.
  claudeDir?: string;
  home?: string;
};

type Json = Record<string, unknown>;

function userDir(where: ClaudeCodeWhere): string {
  return where.claudeDir ?? claudeConfigDir(where.env, where.home);
}

// Where claude mcp add keeps user and local servers.
// $CLAUDE_CONFIG_DIR/.claude.json when that is set, else ~/.claude.json.
function claudeJsonPath(where: ClaudeCodeWhere): string {
  const dir = readEnv('CLAUDE_CONFIG_DIR', where.env);
  return dir !== undefined
    ? join(dir, '.claude.json')
    : join(where.home ?? homedir(), '.claude.json');
}

// The nearest folder at or above cwd that holds .mcp.json or a .claude
// folder, below the home folder, whose .claude is the user settings. cwd
// itself when there is none.
export async function projectDir(
  cwd: string,
  home: string = homedir(),
): Promise<string> {
  let dir = cwd;
  for (;;) {
    if (dir === home) return cwd;
    if (
      (await isFile(join(dir, '.mcp.json'))) ||
      (await isDir(join(dir, '.claude')))
    ) {
      return dir;
    }
    const up = dirname(dir);
    if (up === dir) return cwd;
    dir = up;
  }
}

// The three parts Claude Code shows, hashed for agentId. Prompt is not
// declared.
export async function captureClaudeCode(
  agentId: string,
  where: ClaudeCodeWhere,
): Promise<CapturedParts> {
  return (await readClaudeCode(agentId, where)).parts;
}

// The parts and the model name of the one model id they hash, null when
// none is set or the id gives no name.
async function readClaudeCode(
  agentId: string,
  where: ClaudeCodeWhere,
): Promise<{ parts: CapturedParts; name: string | null }> {
  const project = await projectDir(where.cwd, where.home);
  // Highest precedence first, the way Claude Code merges them.
  const files = [
    join(project, '.claude', 'settings.local.json'),
    join(project, '.claude', 'settings.json'),
    join(userDir(where), 'settings.json'),
  ];
  const settings = (await Promise.all(files.map(readJson))).filter(
    (s): s is Json => s !== null,
  );
  const mcp = await readJson(join(project, '.mcp.json'));
  const claudeJson = await readJson(claudeJsonPath(where));
  // User servers at the top level, local servers under the project's path.
  const projects = objectOf(claudeJson?.projects);
  const userServers = [
    claudeJson,
    objectOf(projects?.[project]),
    project === where.cwd ? null : objectOf(projects?.[where.cwd]),
  ].flatMap((o) => Object.keys(objectOf(o?.mcpServers) ?? {}));
  const hash = (content: string) => partHash(agentId, content);
  const raw = modelIdOf(settings, where.env);
  const model = toolNameOf(raw);
  return {
    parts: {
      model_set:
        model === null
          ? FINGERPRINT_NOT_DECLARED
          : await hash(modelSetContent([model])),
      prompt: FINGERPRINT_NOT_DECLARED,
      tools: await toolsPart(settings, mcp, userServers, hash),
      framework: await frameworkPart(where.env, hash),
    },
    name: modelNameOf(raw),
  };
}

// Captures the parts and keeps them as the claude-code source. For the
// SessionStart and SessionEnd hooks, never throws.
export async function observeClaudeCode(
  agentId: string,
  where: ClaudeCodeWhere,
  p: Paths,
): Promise<void> {
  try {
    const { parts, name } = await readClaudeCode(agentId, where);
    const observed: ObservedParts = {};
    // The model the model part hashes, as a name, the one sync declares.
    if (name !== null) observed.model_name = name;
    if (parts.model_set !== FINGERPRINT_NOT_DECLARED) {
      observed.model_set = parts.model_set;
    }
    if (parts.tools !== FINGERPRINT_NOT_DECLARED) observed.tools = parts.tools;
    if (parts.framework !== FINGERPRINT_NOT_DECLARED) {
      observed.framework = parts.framework;
    }
    await replaceSource('claude-code', observed, p);
  } catch {
    // The next session start or end tries again.
  }
}

type Hash = (content: string) => Promise<string>;

// One model id, as it is written. ANTHROPIC_MODEL in the environment, then
// ANTHROPIC_MODEL in a settings file's env block, which Claude Code puts in
// its environment, then a settings file's model, which may be an alias
// such as opus. The model part hashes it through toolNameOf, the model
// name is modelNameOf of it. null when none is set, since Claude Code's
// own default is not written anywhere, and the model part is then not
// declared.
function modelIdOf(settings: Json[], env: NodeJS.ProcessEnv): string | null {
  const candidates = [
    readEnv('ANTHROPIC_MODEL', env),
    ...settings.map((s) => stringOf(objectOf(s.env)?.ANTHROPIC_MODEL)),
    ...settings.map((s) => stringOf(s.model)),
  ];
  return candidates.find((c) => toolNameOf(c) !== null) ?? null;
}

// MCP server names from .mcp.json, from ~/.claude.json (userServers) and
// any mcpServers or enabledMcpjsonServers in the settings, less
// disabledMcpjsonServers, as mcp:<name>. The MCP tools the settings allow,
// permissions.allow rules that start with mcp__, as tool:<name>. Sorted,
// one per line. Not declared when none of those files has anything to
// read. Only names are read, never commands, arguments, URLs or env.
async function toolsPart(
  settings: Json[],
  mcp: Json | null,
  userServers: string[],
  hash: Hash,
): Promise<CapturedPart> {
  if (mcp === null && settings.length === 0 && userServers.length === 0) {
    return FINGERPRINT_NOT_DECLARED;
  }
  const servers = new Set<string>([
    ...Object.keys(objectOf(mcp?.mcpServers) ?? {}),
    ...userServers,
  ]);
  const disabled = new Set<string>();
  const tools = new Set<string>();
  for (const s of settings) {
    for (const name of Object.keys(objectOf(s.mcpServers) ?? {})) {
      servers.add(name);
    }
    for (const name of stringsOf(s.enabledMcpjsonServers)) servers.add(name);
    for (const name of stringsOf(s.disabledMcpjsonServers)) disabled.add(name);
    for (const rule of stringsOf(objectOf(s.permissions)?.allow)) {
      if (rule.startsWith('mcp__')) tools.add(rule);
    }
  }
  const lines = [
    ...[...servers].filter((n) => !disabled.has(n)).map((n) => `mcp:${n}`),
    ...[...tools].map((n) => `tool:${n}`),
  ];
  return hash(linesContent(lines));
}

// Claude Code's version, from the environment of the running Claude Code
// or else from the claude binary on PATH. Not declared when neither says.
async function frameworkPart(
  env: NodeJS.ProcessEnv,
  hash: Hash,
): Promise<CapturedPart> {
  const version = versionFromEnv(env) ?? (await versionFromPath(env));
  return version === null
    ? FINGERPRINT_NOT_DECLARED
    : hash(frameworkContent('claude-code', version));
}

const AI_AGENT = /^claude-code_(\d+)-(\d+)-(\d+)(?:_|$)/;

// Claude Code 2.1.283 sets both in the shells it spawns, seen in the
// environment of its Bash tool on 27 September 2026. CLAUDE_CODE_EXECPATH
// is the running binary, which a native install keeps under
// versions/<version>. AI_AGENT reads as claude-code_2-1-283_agent.
export function versionFromEnv(env: NodeJS.ProcessEnv): string | null {
  const exec = readEnv('CLAUDE_CODE_EXECPATH', env);
  if (exec !== undefined && isVersion(basename(exec))) return basename(exec);
  const agent = AI_AGENT.exec(readEnv('AI_AGENT', env) ?? '');
  return agent === null ? null : `${agent[1]}.${agent[2]}.${agent[3]}`;
}

// Each claude on PATH in order, its real path followed. A native install
// links to versions/<version>. An npm install links to cli.js in the
// @anthropic-ai/claude-code package, whose package.json has the version.
// A wrapper script says neither and the next one is tried.
async function versionFromPath(env: NodeJS.ProcessEnv): Promise<string | null> {
  const dirs = (env.PATH ?? '').split(delimiter).filter((d) => d !== '');
  for (const dir of dirs) {
    let real: string;
    try {
      real = await realpath(join(dir, 'claude'));
    } catch {
      continue;
    }
    if (isVersion(basename(real))) return basename(real);
    const version = await findPackageVersion(
      '@anthropic-ai/claude-code',
      dirname(real),
    );
    if (version !== null) return version;
  }
  return null;
}

async function readJson(file: string): Promise<Json | null> {
  try {
    return objectOf(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return null;
  }
}

function objectOf(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v !== '')
    : [];
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
}

async function isDir(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}
