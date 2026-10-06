// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// For tests. The purpose the API expects a signed request to name (VOU-637),
// so a fake API checks the CLI signed each request for the route it sent it
// to, and takes purpose off before it parses, as the API does.
import { type RequestPurpose, readPurpose } from '@sealkeeper/schema';

const ROUTES: [string, RegExp, RequestPurpose][] = [
  ['POST', /^\/v1\/agents$/, 'agent.register'],
  ['PATCH', /^\/v1\/agents\/[^/]+$/, 'agent.update'],
  ['DELETE', /^\/v1\/agents\/[^/]+$/, 'agent.delete'],
  ['POST', /^\/v1\/agents\/[^/]+\/status$/, 'agent.status'],
  ['POST', /^\/v1\/agents\/[^/]+\/run$/, 'agent.run'],
  ['POST', /^\/v1\/agents\/[^/]+\/routine\/next$/, 'routine.next'],
  ['POST', /^\/v1\/agents\/[^/]+\/challenge\/next$/, 'challenge.next'],
  ['POST', /^\/v1\/agents\/[^/]+\/duel\/next$/, 'duel.next'],
  ['POST', /^\/v1\/tasks$/, 'task.post'],
  ['POST', /^\/v1\/tasks\/open$/, 'task.open'],
  ['POST', /^\/v1\/tasks\/[^/]+\/claim$/, 'task.claim'],
  ['POST', /^\/v1\/tasks\/[^/]+\/submit$/, 'task.submit'],
  ['POST', /^\/v1\/tasks\/[^/]+\/release$/, 'task.release'],
  ['POST', /^\/v1\/tasks\/[^/]+\/outcome$/, 'task.outcome'],
  ['POST', /^\/v1\/tasks\/[^/]+\/submission$/, 'task.submission'],
  ['POST', /^\/v1\/ratings$/, 'rating.post'],
  ['POST', /^\/v1\/game\/status$/, 'game.status'],
  ['PUT', /^\/v1\/game\/settings$/, 'game.settings'],
];

// The purpose of a signed request to method and path, a URL or its
// pathname. Throws for a route that takes no signed request.
export function purposeOf(method: string, path: string): RequestPurpose {
  const pathname = path.startsWith('/') ? path : new URL(path).pathname;
  const hit = ROUTES.find(([m, re]) => m === method && re.test(pathname));
  if (hit === undefined) {
    throw new Error(`no signed route ${method} ${pathname}`);
  }
  return hit[2];
}

// The payload with purpose taken off, and whether it named the purpose of
// method and path. Call after readAudience.
export function takePurpose(
  payload: unknown,
  method: string,
  path: string,
): { ok: boolean; payload: unknown } {
  const check = readPurpose(payload, purposeOf(method, path));
  return { ok: check.result === 'match', payload: check.payload };
}
