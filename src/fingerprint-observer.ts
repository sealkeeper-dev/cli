// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// What the in-process adapters (Mastra, OpenClaw) see of the fingerprint parts,
// held for the life of the process, and what a routine run's own setup is, the
// model its runtime reported, the runtime's version and its tools, held for
// the run and written to the run's own source. The hashes go to
// fingerprint-sources.json only when a part changes, a new model id, a new tool
// set, new instructions text or the framework version found once, never per
// model step that shows nothing new. The model name of the first model id goes
// too, as text, the one value here that is not a hash.
// The fingerprint itself is recomputed at sync, run, duel, challenge and during
// a routine run from that file, see fingerprint.ts.
import { createHash } from 'node:crypto';
import { partHash } from '@sealkeeper/schema';
import { paths as defaultPaths, type Paths, readConfig } from './config.js';
import {
  type FingerprintSource,
  type ObservedParts,
  observeParts,
} from './fingerprint.js';
import {
  frameworkContent,
  linesContent,
  modelSetContent,
} from './fingerprint-content.js';
import { quietly } from './output.js';
import { ensurePromptSecret } from './prompt-secret.js';

export type FingerprintObserver = {
  // A model id seen on a step or in a hook, already a name (toolNameOf),
  // and the model name it gives (modelNameOf), null when none.
  model: (id: string, name: string | null) => Promise<void>;
  // One line per tool, keyed by the tool name, as in name<TAB>schemas. A
  // name seen again replaces its line.
  tools: (lines: ReadonlyMap<string, string>) => Promise<void>;
  // The agent's instructions as text, for the prompt part. Only a hash of the
  // text is kept, never the text.
  prompt: (text: string) => Promise<void>;
  // The framework and its version, looked up once by the adapter.
  framework: (name: string, version: string) => Promise<void>;
  // Resolves once every write so far has finished. For tests.
  settled: () => Promise<void>;
};

// The most instructions texts one process declares in its prompt part. A
// process that builds its instructions per call would otherwise grow the set
// and write the sources file on every call.
export const PROMPT_TEXTS_MAX = 8;

// One observer per adapter per process, or per routine run. Every write is
// queued behind the last, and none can reject or print, since the agent
// must never notice.
export function createObserver(
  adapter: FingerprintSource,
  paths?: () => Paths,
): FingerprintObserver {
  const models = new Set<string>();
  let name: string | undefined;
  const tools = new Map<string, string>();
  let toolsWritten = false;
  const prompts = new Set<string>();
  const written: ObservedParts = {};
  let queue: Promise<void> = Promise.resolve();

  // Each part is hashed for the agent of the home, read when it is written.
  // Without a config there is no agent and nothing is written.
  const write = (
    build: (agentId: string, p: Paths) => Promise<ObservedParts>,
  ) => {
    queue = queue.then(() =>
      quietly(async () => {
        try {
          const p = paths?.() ?? defaultPaths();
          const config = await readConfig(p);
          if (config === null) return;
          const parts = await build(config.agentId, p);
          const changed = (
            Object.keys(parts) as (keyof ObservedParts)[]
          ).filter((k) => parts[k] !== written[k]);
          if (changed.length === 0) return;
          await observeParts(adapter, parts, p);
          Object.assign(written, parts);
        } catch {
          // The next change tries again.
        }
      }),
    );
    return queue;
  };

  return {
    // The model name goes with the set, as text, the name of the first model id
    // this process sees, kept for the life of the process. A process that runs
    // two models so names the same one at every sync. When the first id gives
    // no name, none is written and an earlier process's name is cleared.
    // Written only when the set grows, never per step. The runtime reported the
    // id, so a Claude Code hook later keeps it over the settings.
    model: (id, idName) => {
      if (models.has(id)) return queue;
      models.add(id);
      if (models.size === 1) name = idName ?? undefined;
      return write(async (agentId) => ({
        model_set: await partHash(agentId, modelSetContent(models)),
        model_name: name,
        model_reported: true,
      }));
    },
    tools: (lines) => {
      let grew = false;
      for (const [name, line] of lines) {
        if (tools.get(name) !== line) grew = true;
        tools.set(name, line);
      }
      // The first call writes even an empty list, so a setup with no tools
      // declares that. A later call writes only when the list grew.
      if (!grew && toolsWritten) return queue;
      toolsWritten = true;
      return write(async (agentId) => ({
        tools: await partHash(agentId, linesContent(tools.values())),
      }));
    },
    // One line per instructions text this process was given, the SHA-256 of the
    // text in hex, so a text that spans lines is still one line and a process
    // that serves two agents declares both, as the tools part keeps every tool.
    // The text is dropped once hashed. Written only when a new text comes,
    // never per call. Past PROMPT_TEXTS_MAX texts a new one is ignored and the
    // part keeps the hash it has until the process restarts. The lines follow
    // the home's prompt secret and one newline, so the hash, which ends up in
    // the public fingerprint, cannot be matched by guessing the text. The
    // secret is made here when its file is missing, and when it cannot be
    // read or made the part is not written this time.
    prompt: (text) => {
      const line = createHash('sha256').update(text, 'utf8').digest('hex');
      if (prompts.has(line) || prompts.size >= PROMPT_TEXTS_MAX) return queue;
      prompts.add(line);
      return write(async (agentId, p) => ({
        prompt: await partHash(
          agentId,
          `${await ensurePromptSecret(p)}\n${linesContent(prompts)}`,
        ),
      }));
    },
    framework: (name, version) =>
      write(async (agentId) => ({
        framework: await partHash(agentId, frameworkContent(name, version)),
      })),
    settled: () => queue,
  };
}
