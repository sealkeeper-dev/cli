// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CLI_VERSION_HEADER, WELL_KNOWN_URL } from '@sealkeeper/schema';
import { describe, expect, it } from 'vitest';
import { LOCK_FILE, STAMP_FILE } from './background-sync.js';
import { commandPaths } from './claude-code-command.js';
import {
  HOOK_EVENTS,
  RETIRED_HOOK_EVENTS,
  settingsPath,
  sharedProjectSettingsPath,
} from './claude-code-settings.js';
import { skillPath } from './claude-code-skill.js';
import { COMMAND_SENDS, REQUESTS_SIGNED } from './commands/what-is-shared.js';
import { agentsMapPath, DEFAULT_API_URL, type Paths, paths } from './config.js';
import { ACCESS_TOKEN_URL, DEVICE_CODE_URL } from './github-device.js';
import { routinePaths } from './routine.js';
import { copyPaths } from './routine-copy.js';
import {
  jobName,
  launchdPath,
  schtasksName,
  systemdDir,
} from './routine-scheduler.js';

// TRUST-4. The What init does section of the README lists every file the
// CLI writes, every job it installs and every host it contacts, from the
// code that names them, so a new file or host cannot go unlisted. The web
// page /docs/init carries the same section word for word, which
// apps/web/lib/init-inventory.test.ts checks against this README.

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

// The section from its heading to the next level two heading.
function section(): string {
  const start = README.indexOf('\n## What init does\n');
  expect(start).toBeGreaterThan(-1);
  const end = README.indexOf('\n## ', start + 1);
  return README.slice(start, end === -1 ? undefined : end);
}

// Paths in the README are written from a home of /h as ~.
const HOME = '/h';
const ROOT = `${HOME}/.sealkeeper`;
const tilde = (path: string) => `~${path.slice(HOME.length)}`;

describe('the What init does inventory', () => {
  const text = section();

  it('lists every file paths() names in the SealKeeper home, one line each', () => {
    const p = paths(ROOT);
    const dirs = new Set<keyof Paths>(['log', 'sessions']);
    for (const key of Object.keys(p) as (keyof Paths)[]) {
      if (key === 'home' || key === 'logFile') continue;
      const path = `${tilde(p[key] as string)}${dirs.has(key) ? '/' : ''}`;
      expect(text, key).toMatch(
        new RegExp(
          `^- \`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`, `,
          'm',
        ),
      );
    }
  });

  it('lists the other files the CLI keeps in the home', () => {
    expect(text).toContain(`\`${tilde(agentsMapPath(ROOT))}\``);
    expect(text).toContain(`\`${tilde(`${ROOT}/${LOCK_FILE}`)}\``);
    expect(text).toContain(`\`${STAMP_FILE}\``);
    expect(text).toContain('`~/.sealkeeper/key.<time>.bak`');
    // The routine's files share one line. The first carries the home.
    const r = routinePaths(paths(ROOT));
    const [first, ...rest] = [r.log, r.lock, r.out];
    expect(text).toContain(`- \`${tilde(first ?? '')}\`, `);
    for (const file of rest) {
      expect(text, file).toContain(`\`${file.slice(ROOT.length + 1)}\``);
    }
    // The copy of the CLI the daily job runs, and its version (RS-2).
    const copy = copyPaths(paths(ROOT));
    expect(text).toContain(
      `- \`${tilde(copy.script)}\` and \`${copy.meta.slice(ROOT.length + 1)}\`, `,
    );
    expect(text).toContain(`\`${tilde(copy.script)}\`, a copy of this CLI`);
    // The last run's transcript beside it (RS-10).
    expect(text).toContain(`- \`${tilde(copy.transcript)}\`, `);
  });

  it('lists the files written into Claude Code and every hook event', () => {
    const user = settingsPath('user', { home: HOME, cwd: '/c' });
    expect(text).toContain(`- \`${tilde(user)}\`, two hooks`);
    expect(HOOK_EVENTS).toHaveLength(2);
    for (const event of HOOK_EVENTS) expect(text).toContain(`\`${event}\``);
    // The hooks an older install wrote, which install takes out.
    for (const event of RETIRED_HOOK_EVENTS) {
      expect(text).toContain(`\`${event}\``);
    }
    for (const path of commandPaths(user)) {
      expect(text).toContain(`- \`${tilde(path)}\`, `);
    }
    expect(text).toContain(`- \`${tilde(skillPath(user))}\`, `);
    expect(text).toContain('`CLAUDE_CONFIG_DIR`');
  });

  it('lists the files project scope writes, and the shared settings it rewrites', () => {
    const cwd = '/c';
    const inProject = (path: string) => path.slice(`${cwd}/`.length);
    const project = settingsPath('project', { home: HOME, cwd });
    const scope = text.slice(text.indexOf('into the project instead'));
    expect(scope).toContain(
      `the hooks to \`${inProject(project)}\`, the slash commands to \`${inProject(dirname(commandPaths(project)[0] ?? ''))}\` and the skill to \`${inProject(skillPath(project))}\``,
    );
    expect(scope).toContain(
      `rewrites the project's \`${inProject(sharedProjectSettingsPath(cwd))}\``,
    );
  });

  it('lists the file seal write puts where you ask', () => {
    expect(text).toContain('- `seal.txt` from `seal write`');
    // init writes the card into the home (VOU-603), card write is gone.
    expect(text).not.toContain('card write');
  });

  it('says status reads the card record and sends nothing for it', () => {
    // status shows the card's state from the files alone (VOU-619).
    expect(text).toMatch(
      /^- `~\/\.sealkeeper\/card-write\.json`, .*`status` reads it to show the card's state, sending nothing\.$/m,
    );
  });

  it('names the signed changes init and status may send, and both kinds of content', () => {
    const sends = text.slice(text.indexOf('### What each command sends'));
    expect(sends).toMatch(/^- `init` .*move the version .*`unknown`/m);
    expect(sends).toMatch(
      /^- `status` sends the time of the request alone, signed, and only reads\. It asks what the agent runs in .*`unknown`/m,
    );
    expect(sends).toContain(
      'The answer and the task are the only content that leaves your machine',
    );
  });

  // VOU-624. what-is-shared prints the same list, so the README and the
  // CLI cannot say different things. The README adds backticks only.
  it('says what each command sends as what-is-shared prints it', () => {
    const sends = text.slice(text.indexOf('### What each command sends'));
    const plain = (line: string) => line.replaceAll('`', '');
    const bullets = sends
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => plain(line.slice(2)));
    expect(bullets).toEqual(COMMAND_SENDS);
    const intro = sends.split('\n\n')[1] ?? '';
    expect(plain(intro).startsWith(REQUESTS_SIGNED)).toBe(true);
  });

  it('lists the scheduler entry on each platform', () => {
    const job = jobName(ROOT, ROOT);
    const env = { platform: 'linux' as const, homedir: HOME, uid: 501 };
    expect(text).toContain(`\`${tilde(launchdPath(job, env))}\``);
    expect(text).toContain(`\`${job}.service\` and \`${job}.timer\``);
    expect(text).toContain(`\`${tilde(systemdDir(env))}\``);
    expect(text).toContain(`\`# BEGIN ${job}\``);
    expect(text).toContain(`\`# END ${job}\``);
    expect(text).toContain(`\`${schtasksName(job)}\``);
  });

  it('lists every host the CLI contacts, and nothing more', () => {
    const hosts = text.slice(
      text.indexOf('### Hosts it contacts'),
      text.indexOf('### What each command sends'),
    );
    const urls = [...hosts.matchAll(/`(https:\/\/[^`]+)`/g)].map((m) => m[1]);
    expect(urls).toEqual([
      DEVICE_CODE_URL,
      ACCESS_TOKEN_URL,
      DEFAULT_API_URL,
      WELL_KNOWN_URL,
    ]);
    expect(hosts).toContain(
      "The CLI itself contacts nothing else and has no analytics. The daily job's Claude Code session talks to Anthropic, as Claude Code always does, and its OpenClaw talks to the provider of the model the routine names.",
    );
  });

  it('points at what-is-shared for the fields and makes no hashes only claim', () => {
    expect(text).toContain('`npx sealkeeper what-is-shared`');
    expect(text).toContain(
      'Events are metadata only, task outcomes, and the start, end, token counts, answer times and model id of routine runs. Never prompts, tool arguments, outputs or file contents. Hashes stand in where a check needs evidence.',
    );
    expect(README).not.toMatch(/only hash/i);
    // The field table is linked, not repeated.
    expect(text).not.toContain('| `tool.call` |');
  });
});

// VOU-453. What leaves your machine names the header every API request
// carries as the schema spells it.
describe('What leaves your machine', () => {
  it('names the CLI version header', () => {
    const start = README.indexOf('\n## What leaves your machine\n');
    expect(start).toBeGreaterThan(-1);
    const end = README.indexOf('\n## ', start + 1);
    expect(README.slice(start, end)).toContain(
      `Every request to the SealKeeper API carries the header \`${CLI_VERSION_HEADER}\`, which holds the version of the CLI that sends it`,
    );
  });
});
