// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// Guards the rule that no build time package runs where npm can be reached
// with this package's publish rights.
// The release workflow has two jobs. One installs, lints, typechecks, tests,
// builds and packs, with contents read only. The other alone holds
// id-token write, the OIDC token npm Trusted Publishing accepts, and it
// checks out nothing, installs nothing and runs no package script. It stages
// the tarball the first job packed. Every npm ci, in both workflows, skips
// install scripts. Every action is pinned by commit, and every checkout
// leaves no credential behind. The files are read as text, line by line,
// which their plain shape allows.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function workflow(name: string): string {
  return readFileSync(join(packageDir, '.github', 'workflows', name), 'utf8');
}

/** The indented lines under a top level key, until the next top level key. */
function topLevel(text: string, key: string): string {
  const lines = text.split('\n');
  const start = lines.indexOf(`${key}:`);
  if (start < 0) return '';
  const end = lines.findIndex((line, i) => i > start && /^\S/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

/** Each job under jobs, by its key, as the text of its block. */
function jobs(text: string): Map<string, string> {
  const found = new Map<string, string>();
  let name: string | null = null;
  let body: string[] = [];
  for (const line of topLevel(text, 'jobs').split('\n')) {
    const key = /^ {2}([\w-]+):\s*$/.exec(line);
    if (key) {
      if (name) found.set(name, body.join('\n'));
      name = key[1] ?? null;
      body = [];
    } else if (name) {
      body.push(line);
    }
  }
  if (name) found.set(name, body.join('\n'));
  return found;
}

/** The steps of a job, each as the text from its leading dash. */
function steps(job: string): string[] {
  return job.split(/\n(?= {6}- )/).filter((part) => /^ {6}- /.test(part));
}

const release = workflow('release.yml');
const releaseJobs = jobs(release);
const WORKFLOWS = { 'release.yml': release, 'ci.yml': workflow('ci.yml') };

describe('release workflow', () => {
  it('grants id-token write to no job by default', () => {
    expect(topLevel(release, 'permissions')).not.toMatch(/id-token/);
  });

  it('has exactly one job that can mint the npm OIDC token, the stage job', () => {
    const minting = [...releaseJobs].filter(([, job]) =>
      /id-token:\s*write/.test(job),
    );
    expect(minting.map(([name]) => name)).toEqual(['stage']);
  });

  it('builds in a job with contents read only', () => {
    const build = releaseJobs.get('build') ?? '';
    expect(build).toMatch(/permissions:\n {6}contents: read\n/);
    expect(build).not.toMatch(/id-token/);
    for (const command of [
      'npm ci --ignore-scripts',
      'npm run lint',
      'npm run typecheck',
      'npm test',
      'npm run build',
      'npm pack --ignore-scripts',
      'actions/upload-artifact@',
    ]) {
      expect(build).toContain(command);
    }
  });

  it('stages from the packed tarball and runs nothing from the package', () => {
    const stage = releaseJobs.get('stage') ?? '';
    expect(stage).toMatch(/needs: build\n/);
    expect(stage).toMatch(/environment: npm\n/);
    // Only these two actions run beside the token.
    expect(
      (stage.match(/uses: [\w./-]+@/g) ?? []).map((use) => use.slice(6, -1)),
    ).toEqual(['actions/setup-node', 'actions/download-artifact']);
    // No source, no install, no package script. npm runs no lifecycle
    // script when the spec is a tarball, and --ignore-scripts says so too.
    for (const banned of [
      /actions\/checkout/,
      /\bnpm (?:ci|install|i|test|run|exec|pack)\b/,
      /\bnpx\b/,
      /\bcache:/,
    ]) {
      expect(stage).not.toMatch(banned);
    }
    const publishes = stage.match(/npm stage publish .*/g) ?? [];
    expect(publishes).toHaveLength(1);
    expect(publishes[0]).toMatch(/npm stage publish "\S+\.tgz"/);
    expect(publishes[0]).toContain('--provenance');
    expect(publishes[0]).toContain('--ignore-scripts');
  });

  it('builds with the client id and stages without it', () => {
    expect(topLevel(release, 'env')).toBe('');
    expect(releaseJobs.get('build')).toContain(
      'GITHUB_CLIENT_ID: Ov23liER4N1b1XVokKPA',
    );
    expect(releaseJobs.get('stage')).not.toContain('GITHUB_CLIENT_ID');
  });
});

describe.each(Object.entries(WORKFLOWS))('%s', (_name, text) => {
  it('skips install scripts on every npm ci', () => {
    const installs = text.match(/npm ci\b.*/g) ?? [];
    expect(installs.length).toBeGreaterThan(0);
    for (const install of installs)
      expect(install).toContain('--ignore-scripts');
  });

  it('pins every action by commit', () => {
    const uses = text.match(/uses: \S+/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses)
      expect(use).toMatch(/^uses: [\w./-]+@[0-9a-f]{40}$/);
  });

  it('leaves no credential behind on any checkout', () => {
    for (const job of jobs(text).values()) {
      for (const step of steps(job)) {
        if (step.includes('actions/checkout@')) {
          expect(step).toMatch(/persist-credentials: false/);
        }
      }
    }
  });
});
