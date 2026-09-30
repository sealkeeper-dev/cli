// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// What the in-process adapters (Mastra, OpenClaw) see of the fingerprint
// parts, held for the life of the process. The hashes go to
// fingerprint-sources.json only when a part changes, a new model id, a new
// tool set or the framework version found once, never per model step that
// shows nothing new. The model name of the first model id goes too, as
// text, the one value here that is not a hash (VOU-566). The fingerprint
// itself is recomputed at sync and prove from that file, see
// fingerprint.ts.
import { partHash } from '@sealkeeper/schema';
import { paths as defaultPaths, type Paths, readConfig } from './config.js';
import {
  type ObservedParts,
  type ObservingAdapter,
  observeParts,
} from './fingerprint.js';
import {
  frameworkContent,
  linesContent,
  modelSetContent,
} from './fingerprint-content.js';
import { quietly } from './output.js';

export type FingerprintObserver = {
  // A model id seen on a step or in a hook, already a name (toolNameOf),
  // and the model name it gives (modelNameOf), null when none.
  model: (id: string, name: string | null) => Promise<void>;
  // One line per tool, keyed by the tool name, as in name<TAB>schemas. A
  // name seen again replaces its line.
  tools: (lines: ReadonlyMap<string, string>) => Promise<void>;
  // The framework and its version, looked up once by the adapter.
  framework: (name: string, version: string) => Promise<void>;
  // Resolves once every write so far has finished. For tests.
  settled: () => Promise<void>;
};

// One observer per adapter per process. Every write is queued behind the
// last, and none can reject or print, since the agent must never notice.
export function createObserver(
  adapter: ObservingAdapter,
  paths?: () => Paths,
): FingerprintObserver {
  const models = new Set<string>();
  let name: string | undefined;
  const tools = new Map<string, string>();
  const written: ObservedParts = {};
  let queue: Promise<void> = Promise.resolve();

  // Each part is hashed for the agent of the home, read when it is written.
  // Without a config there is no agent and nothing is written.
  const write = (build: (agentId: string) => Promise<ObservedParts>) => {
    queue = queue.then(() =>
      quietly(async () => {
        try {
          const p = paths?.() ?? defaultPaths();
          const config = await readConfig(p);
          if (config === null) return;
          const parts = await build(config.agentId);
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
    // The model name goes with the set, as text (VOU-566), the name of the
    // first model id this process sees, kept for the life of the process.
    // A process that runs two models, one to plan and one for the steps,
    // so names the same one at every sync and never records a change of
    // model it did not make. When the first id gives no name, none is
    // written and an earlier process's name is cleared. Written only when
    // the set grows, never per step.
    model: (id, idName) => {
      if (models.has(id)) return queue;
      models.add(id);
      if (models.size === 1) name = idName ?? undefined;
      return write(async (agentId) => ({
        model_set: await partHash(agentId, modelSetContent(models)),
        model_name: name,
      }));
    },
    tools: (lines) => {
      let grew = false;
      for (const [name, line] of lines) {
        if (tools.get(name) !== line) grew = true;
        tools.set(name, line);
      }
      if (!grew) return queue;
      return write(async (agentId) => ({
        tools: await partHash(agentId, linesContent(tools.values())),
      }));
    },
    framework: (name, version) =>
      write(async (agentId) => ({
        framework: await partHash(agentId, frameworkContent(name, version)),
      })),
    settled: () => queue,
  };
}
