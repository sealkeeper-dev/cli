// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RoutineSchedule, SchedulerKind } from './config.js';
import { writeFileAtomic } from './config.js';
import { readIfExists } from './files.js';

// The daily job of sealkeeper routine, written with the operator's own
// scheduler (VOU-136). launchd on macOS, a systemd user timer on Linux when
// the user manager answers, cron otherwise, Task Scheduler on Windows.
//
// Every file carries the managed-by: sealkeeper marker the Claude Code
// command file uses, and the cron entry sits between marker lines, so remove
// only ever takes out what install wrote. Scheduler calls go through a
// Runner, which tests replace.

export const MANAGED_MARKER = 'managed-by: sealkeeper';

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (
  file: string,
  args: string[],
  options?: { input?: string },
) => Promise<RunResult>;

// Runs a program without a shell and collects its output. A program that
// cannot start resolves with code 127.
export const execRunner: Runner = (file, args, options = {}) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: 127, stdout, stderr: (error as Error).message });
      return;
    }
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) =>
      resolve({ code: 127, stdout, stderr: error.message }),
    );
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin?.end(options.input ?? '');
  });

// Where the job files go and who runs them.
export type SchedulerEnv = {
  platform: NodeJS.Platform;
  homedir: string;
  // XDG_CONFIG_HOME, for the systemd user units.
  xdgConfigHome?: string;
  uid: number;
};

// launchd on macOS, Task Scheduler on Windows. On anything else a systemd
// user timer when the user manager answers, else cron.
export async function detectScheduler(
  env: SchedulerEnv,
  run: Runner,
): Promise<SchedulerKind> {
  if (env.platform === 'darwin') return 'launchd';
  if (env.platform === 'win32') return 'schtasks';
  const systemd = await run('systemctl', ['--user', 'show-environment']);
  return systemd.code === 0 ? 'systemd' : 'cron';
}

// What the job runs. program is the CLI's node and script paths followed by
// routine run. env is set for the job, PATH so the agent's own launcher
// finds node, and SEALKEEPER_HOME when this CLI uses another home.
export type JobSpec = {
  time: string;
  program: string[];
  env: Record<string, string>;
  home: string;
  // The file the job's output goes to.
  outFile: string;
};

export type Command = { file: string; args: string[]; input?: string };

// Exactly what install will write and run, for the preview and for apply.
// preview is set when a file's full text is not what the person should
// read, as for cron, where the whole crontab is rewritten.
export type Plan = {
  scheduler: SchedulerKind;
  job: string;
  files: { path: string; text: string }[];
  commands: Command[];
  // Lines to show for a change that is not a file of ours.
  preview?: string[];
};

// A name for this home's job. The default home gets the plain name, any
// other home a short hash, so two homes on one machine keep two jobs.
export function jobName(home: string, defaultHome: string): string {
  if (home === defaultHome) return 'run.sealkeeper.routine';
  const hash = createHash('sha256').update(home).digest('hex').slice(0, 8);
  return `run.sealkeeper.routine.${hash}`;
}

const splitTime = (time: string) => {
  const [hour, minute] = time.split(':').map(Number);
  return { hour: hour ?? 0, minute: minute ?? 0 };
};

// Every value that goes into a job file or command. A line break or any
// other control character would end a line early in a unit file or the
// crontab, or be read differently by each scheduler, so none is allowed.
function refuseControlCharacters(job: string, spec: JobSpec): void {
  const values: [string, string][] = [
    ['the job name', job],
    ['the home', spec.home],
    ['the output file', spec.outFile],
    ...spec.program.map((arg): [string, string] => ['the command', arg]),
    ...Object.entries(spec.env).flatMap(([key, value]): [string, string][] => [
      ['an environment name', key],
      [`the environment variable ${key}`, value],
    ]),
  ];
  for (const [what, value] of values) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it looks for
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      throw new SchedulerError(
        `nothing installed. ${what} holds a line break or another control character, which a scheduler would read differently: ${JSON.stringify(value)}`,
      );
    }
  }
}

export async function planInstall(
  kind: SchedulerKind,
  job: string,
  spec: JobSpec,
  env: SchedulerEnv,
  run: Runner,
): Promise<Plan> {
  refuseControlCharacters(job, spec);
  switch (kind) {
    case 'launchd':
      return launchdPlan(job, spec, env);
    case 'systemd':
      return systemdPlan(job, spec, env);
    case 'cron':
      return cronPlan(job, spec, run);
    case 'schtasks':
      return schtasksPlan(job, spec);
  }
}

// Writes the files, then runs the commands in order. A command that fails
// throws with its output.
export async function applyPlan(
  plan: Plan,
  run: Runner,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  for (const file of plan.files) {
    const current = await readIfExists(file.path);
    if (current !== null && !isOurs(current)) {
      throw new SchedulerError(
        `${file.path} exists and was not written by SealKeeper, it is left alone`,
      );
    }
  }
  for (const file of plan.files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFileAtomic(file.path, file.text, 0o644);
  }
  for (const command of plan.commands) {
    let result = await run(command.file, command.args, {
      input: command.input,
    });
    // launchd may still be tearing down the job bootout just unloaded, and
    // then bootstrap fails with error 5 for a moment.
    for (
      let retry = 0;
      retry < BOOTSTRAP_RETRIES && bootstrapBusy(command, result);
      retry++
    ) {
      await sleep(BOOTSTRAP_RETRY_MS);
      result = await run(command.file, command.args, { input: command.input });
    }
    if (result.code !== 0 && !mayFail(command)) {
      throw new SchedulerError(
        `${[command.file, ...command.args].join(' ')} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`,
      );
    }
  }
}

// Unloading a launchd job that is not loaded fails, and that is fine.
const mayFail = (command: Command) =>
  command.file === 'launchctl' && command.args[0] === 'bootout';

const BOOTSTRAP_RETRIES = 5;
const BOOTSTRAP_RETRY_MS = 500;

const bootstrapBusy = (command: Command, result: RunResult) =>
  command.file === 'launchctl' &&
  command.args[0] === 'bootstrap' &&
  result.code !== 0 &&
  /Bootstrap failed: 5\b/.test(`${result.stderr}\n${result.stdout}`);

export class SchedulerError extends Error {
  override name = 'SchedulerError';
}

// Ours when the marker is in the first few lines.
export function isOurs(text: string): boolean {
  return text
    .split(/\r?\n/)
    .slice(0, 4)
    .some((l) => l.includes(MANAGED_MARKER));
}

// Removes what install wrote. Files without the marker are left alone and
// reported in kept. The scheduler is told first, so it stops using them.
export async function removeJob(
  schedule: Pick<RoutineSchedule, 'scheduler' | 'job' | 'files'>,
  env: SchedulerEnv,
  run: Runner,
): Promise<{ removed: string[]; kept: string[] }> {
  const removed: string[] = [];
  const kept: string[] = [];
  const ours: string[] = [];
  for (const path of schedule.files) {
    const text = await readIfExists(path);
    if (text === null) continue;
    if (isOurs(text)) ours.push(path);
    else kept.push(path);
  }
  switch (schedule.scheduler) {
    case 'launchd':
      await run('launchctl', ['bootout', `gui/${env.uid}/${schedule.job}`]);
      break;
    case 'systemd':
      await run('systemctl', [
        '--user',
        'disable',
        '--now',
        `${schedule.job}.timer`,
      ]);
      break;
    case 'cron': {
      const current = await readCrontab(run);
      const next = withoutBlock(current, schedule.job);
      if (next !== current) {
        await writeCrontab(run, next);
        removed.push(`crontab entry ${schedule.job}`);
      }
      break;
    }
    case 'schtasks': {
      const result = await run('schtasks', [
        '/Delete',
        '/TN',
        schtasksName(schedule.job),
        '/F',
      ]);
      if (result.code === 0) removed.push(`task ${schtasksName(schedule.job)}`);
      break;
    }
  }
  for (const path of ours) {
    await rm(path, { force: true });
    removed.push(path);
  }
  if (schedule.scheduler === 'systemd') {
    await run('systemctl', ['--user', 'daemon-reload']);
  }
  return { removed, kept };
}

// Removes the job named job wherever install would have put it on this
// platform, for a home whose routine settings are gone. Only a file with
// the marker, a cron block between our marker lines or a task in the
// SealKeeper folder of Task Scheduler is removed. A file without the
// marker is reported in kept.
export async function removeJobByName(
  job: string,
  env: SchedulerEnv,
  run: Runner,
): Promise<{ removed: string[]; kept: string[] }> {
  const removed: string[] = [];
  const kept: string[] = [];
  const add = (result: { removed: string[]; kept: string[] }) => {
    removed.push(...result.removed);
    kept.push(...result.kept);
  };
  // The files of ours among files, with the rest in kept.
  const oursOf = async (files: string[]): Promise<string[]> => {
    const ours: string[] = [];
    for (const path of files) {
      const text = await readIfExists(path);
      if (text === null) continue;
      if (isOurs(text)) ours.push(path);
      else kept.push(path);
    }
    return ours;
  };
  if (env.platform === 'darwin') {
    const files = await oursOf([launchdPath(job, env)]);
    if (files.length > 0) {
      add(await removeJob({ scheduler: 'launchd', job, files }, env, run));
    }
    return { removed, kept };
  }
  if (env.platform === 'win32') {
    const found = await run('schtasks', ['/Query', '/TN', schtasksName(job)]);
    if (found.code === 0) {
      add(await removeJob({ scheduler: 'schtasks', job, files: [] }, env, run));
    }
    return { removed, kept };
  }
  const dir = systemdDir(env);
  const units = await oursOf([
    join(dir, `${job}.service`),
    join(dir, `${job}.timer`),
  ]);
  if (units.length > 0) {
    add(await removeJob({ scheduler: 'systemd', job, files: units }, env, run));
  }
  let crontab: string | null = null;
  try {
    crontab = await readCrontab(run);
  } catch {
    // No cron on this machine, so no block to remove.
  }
  if (crontab?.split('\n').includes(cronBegin(job))) {
    add(await removeJob({ scheduler: 'cron', job, files: [] }, env, run));
  }
  return { removed, kept };
}

// launchd

export function launchdPath(job: string, env: SchedulerEnv): string {
  return join(env.homedir, 'Library', 'LaunchAgents', `${job}.plist`);
}

function launchdPlan(job: string, spec: JobSpec, env: SchedulerEnv): Plan {
  const path = launchdPath(job, env);
  const { hour, minute } = splitTime(spec.time);
  const xml = (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const text = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!-- ${MANAGED_MARKER}. Written by sealkeeper routine install, removed by sealkeeper routine remove. -->`,
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xml(job)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...spec.program.map((arg) => `    <string>${xml(arg)}</string>`),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(spec.env).flatMap(([key, value]) => [
      `    <key>${xml(key)}</key>`,
      `    <string>${xml(value)}</string>`,
    ]),
    '  </dict>',
    '  <key>StartCalendarInterval</key>',
    '  <dict>',
    '    <key>Hour</key>',
    `    <integer>${hour}</integer>`,
    '    <key>Minute</key>',
    `    <integer>${minute}</integer>`,
    '  </dict>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(spec.outFile)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(spec.outFile)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  const domain = `gui/${env.uid}`;
  return {
    scheduler: 'launchd',
    job,
    files: [{ path, text }],
    commands: [
      // A job from an earlier install is unloaded first, so the new file is
      // the one launchd reads.
      { file: 'launchctl', args: ['bootout', `${domain}/${job}`] },
      { file: 'launchctl', args: ['bootstrap', domain, path] },
    ],
  };
}

// systemd

export function systemdDir(env: SchedulerEnv): string {
  return join(
    env.xdgConfigHome || join(env.homedir, '.config'),
    'systemd',
    'user',
  );
}

// systemd reads % as a specifier, and a double quoted word takes
// backslash escapes.
const systemdWord = (text: string) =>
  `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

// ExecStart also expands $NAME and ${NAME}, and $$ is a plain $.
const execWord = (text: string) => systemdWord(text).replace(/\$/g, '$$$$');

function systemdPlan(job: string, spec: JobSpec, env: SchedulerEnv): Plan {
  const dir = systemdDir(env);
  const { hour, minute } = splitTime(spec.time);
  const header = [
    `# ${MANAGED_MARKER}. Written by sealkeeper routine install, removed by sealkeeper routine remove.`,
  ];
  const service = [
    ...header,
    '[Unit]',
    'Description=SealKeeper routine, one unattended run toward the next level',
    '',
    '[Service]',
    'Type=oneshot',
    ...Object.entries(spec.env).map(
      ([key, value]) => `Environment=${systemdWord(`${key}=${value}`)}`,
    ),
    `ExecStart=${spec.program.map(execWord).join(' ')}`,
    `StandardOutput=append:${spec.outFile.replace(/%/g, '%%')}`,
    `StandardError=append:${spec.outFile.replace(/%/g, '%%')}`,
    '',
  ].join('\n');
  const timer = [
    ...header,
    '[Unit]',
    'Description=Daily SealKeeper routine',
    '',
    '[Timer]',
    `OnCalendar=*-*-* ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`,
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
  return {
    scheduler: 'systemd',
    job,
    files: [
      { path: join(dir, `${job}.service`), text: service },
      { path: join(dir, `${job}.timer`), text: timer },
    ],
    commands: [
      { file: 'systemctl', args: ['--user', 'daemon-reload'] },
      {
        file: 'systemctl',
        args: ['--user', 'enable', '--now', `${job}.timer`],
      },
    ],
  };
}

// cron

const cronBegin = (job: string) =>
  `# BEGIN ${job} (${MANAGED_MARKER}, removed by sealkeeper routine remove)`;
const cronEnd = (job: string) => `# END ${job}`;

// POSIX shell single quotes. cron hands the line to sh, where % would end
// the command, so it is escaped too.
const shellWord = (text: string) =>
  `'${text.replace(/'/g, `'\\''`)}'`.replace(/%/g, '\\%');

export function cronBlock(job: string, spec: JobSpec): string[] {
  const { hour, minute } = splitTime(spec.time);
  const env = Object.entries(spec.env)
    .map(([key, value]) => `${key}=${shellWord(value)}`)
    .join(' ');
  const command = spec.program.map(shellWord).join(' ');
  return [
    cronBegin(job),
    `${minute} ${hour} * * * ${env ? `${env} ` : ''}${command} >> ${shellWord(spec.outFile)} 2>&1`,
    cronEnd(job),
  ];
}

// The current crontab, or empty when there is none. crontab -l exits 1 for
// a user without one.
async function readCrontab(run: Runner): Promise<string> {
  const result = await run('crontab', ['-l']);
  if (result.code === 0) return result.stdout;
  if (/no crontab/i.test(result.stderr)) return '';
  throw new SchedulerError(
    `could not read the crontab: ${result.stderr.trim() || `exit ${result.code}`}`,
  );
}

async function writeCrontab(run: Runner, text: string): Promise<void> {
  const result = await run('crontab', ['-'], { input: text });
  if (result.code !== 0) {
    throw new SchedulerError(
      `could not write the crontab: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
  }
}

// The crontab without our block for job. Everything else stays as it was.
// A begin line with no end line after it throws, so a crontab someone
// edited by hand never loses the lines after it.
export function withoutBlock(text: string, job: string): string {
  const lines = text.split('\n');
  const begin = lines.indexOf(cronBegin(job));
  if (begin !== -1 && !lines.slice(begin + 1).includes(cronEnd(job))) {
    throw new SchedulerError(
      `the crontab has the line "${cronBegin(job)}" with no "${cronEnd(job)}" after it. Nothing was changed. Fix it with crontab -e, then run this again`,
    );
  }
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line === cronBegin(job)) {
      inside = true;
      continue;
    }
    if (inside) {
      if (line === cronEnd(job)) inside = false;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

async function cronPlan(
  job: string,
  spec: JobSpec,
  run: Runner,
): Promise<Plan> {
  const current = withoutBlock(await readCrontab(run), job);
  const block = cronBlock(job, spec);
  const base = current.replace(/\n*$/, '');
  const next = `${base === '' ? '' : `${base}\n`}${block.join('\n')}\n`;
  return {
    scheduler: 'cron',
    job,
    files: [],
    commands: [{ file: 'crontab', args: ['-'], input: next }],
    preview: [
      'Adds these lines to your crontab:',
      ...block.map((l) => `  ${l}`),
    ],
  };
}

// Task Scheduler

export const schtasksName = (job: string) => `\\SealKeeper\\${job}`;

const windowsWord = (text: string) => `"${text.replace(/"/g, '\\"')}"`;

// The longest command Task Scheduler takes in /TR.
export const SCHTASKS_TR_MAX = 261;

function schtasksPlan(job: string, spec: JobSpec): Plan {
  const program = spec.program.map(windowsWord).join(' ');
  const sets = Object.entries(spec.env)
    .filter(([key]) => key !== 'PATH')
    .map(([key, value]) => `set "${key}=${value}" && `)
    .join('');
  const action = sets === '' ? program : `cmd /c "${sets}${program}"`;
  if (action.length > SCHTASKS_TR_MAX) {
    throw new SchedulerError(
      `nothing installed. Task Scheduler takes a command of at most ${SCHTASKS_TR_MAX} characters, and this one has ${action.length}: ${action}. Install the CLI or node at a shorter path, or use a shorter SEALKEEPER_HOME`,
    );
  }
  return {
    scheduler: 'schtasks',
    job,
    files: [],
    commands: [
      {
        file: 'schtasks',
        args: [
          '/Create',
          '/TN',
          schtasksName(job),
          '/TR',
          action,
          '/SC',
          'DAILY',
          '/ST',
          spec.time,
          '/F',
        ],
      },
    ],
  };
}

// A command as a person would type it, for the preview.
export function commandLine(command: Command): string {
  const word = (text: string) =>
    /^[\w@%+=:,./\\-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
  return [command.file, ...command.args].map(word).join(' ');
}
