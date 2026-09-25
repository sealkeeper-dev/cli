// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
// Guards the rule that the package is self-contained.
// Source may import only the allowed runtime packages, node builtins and
// relative paths that stay inside this package folder. Every .ts file in the
// package also carries the one-line Apache header.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(srcDir, '..');

const ALLOWED_BARE = new Set([
  '@sealkeeper/schema',
  'commander',
  'zod',
  '@noble/ed25519',
]);
const TEST_ONLY_BARE = new Set([
  'vitest',
  'tsup',
  '@sealkeeper/schema/conformance',
]);

const HEADER =
  '// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.';
const SKIP_DIRS = new Set(['node_modules', 'dist']);

const SPECIFIER_PATTERNS = [
  /\bimport\s+(?:type\s+)?[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bexport\s+(?:type\s+)?[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function listFiles(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIP_DIRS.has(entry.name) ? [] : listFiles(full, pattern);
    }
    return pattern.test(entry.name) ? [full] : [];
  });
}

function listSourceFiles(dir: string): string[] {
  return listFiles(dir, /\.(?:[cm]?[jt]sx?)$/);
}

function extractSpecifiers(code: string): string[] {
  const found = new Set<string>();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found];
}

function violation(file: string, specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const target = resolve(dirname(file), specifier);
    const rel = relative(packageDir, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return `relative import escapes the package: ${specifier}`;
    }
    return null;
  }
  if (specifier.startsWith('node:')) return null;
  if (ALLOWED_BARE.has(specifier)) return null;
  if (file.endsWith('.test.ts') && TEST_ONLY_BARE.has(specifier)) return null;
  return `bare import not allowed: ${specifier}`;
}

describe('cli isolation', () => {
  it('extracts every import form', () => {
    // Built from parts so the scan of this file does not see these samples.
    const im = 'im' + 'port';
    const code = [
      `${im} a from 'a'`,
      `${im} type { B } from 'b'`,
      `${'ex' + 'port'} * from 'c'`,
      `${im} 'd'`,
      `await ${im}('e')`,
      `${'req' + 'uire'}('f')`,
    ].join('\n');
    expect(extractSpecifiers(code).sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
    ]);
  });

  it('rejects escaping and unlisted imports', () => {
    const file = join(srcDir, 'x.ts');
    expect(violation(file, '../../schema/src/index.js')).not.toBeNull();
    expect(violation(file, '@sealkeeper/schema/db')).not.toBeNull();
    expect(violation(file, 'left-pad')).not.toBeNull();
    expect(violation(file, 'fs')).not.toBeNull();
    expect(violation(file, '../package.json')).toBeNull();
    expect(violation(file, 'node:fs')).toBeNull();
  });

  it('src imports only allowed modules and stays inside the package', () => {
    const problems = listSourceFiles(srcDir).flatMap((file) =>
      extractSpecifiers(readFileSync(file, 'utf8'))
        .map((specifier) => violation(file, specifier))
        .filter((problem): problem is string => problem !== null)
        .map((problem) => `${relative(packageDir, file)}: ${problem}`),
    );
    expect(problems).toEqual([]);
  });

  it('every .ts file in the package starts with the Apache header', () => {
    const files = listFiles(packageDir, /\.[cm]?tsx?$/);
    expect(files.length).toBeGreaterThan(0);
    const missing = files
      .filter((file) => readFileSync(file, 'utf8').split('\n')[0] !== HEADER)
      .map((file) => relative(packageDir, file));
    expect(missing).toEqual([]);
  });
});
