// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  nodeIsPatched,
  nodeUpdateNote,
  warnUnpatchedNode,
} from './node-version.js';

describe('nodeIsPatched', () => {
  it('passes the first patched release of each line and every later one', () => {
    for (const v of [
      '22.23.4',
      '22.24.0',
      '24.22.1',
      'v24.22.1',
      '24.30.0',
      '26.12.1',
      '26.13.0',
      '27.0.0',
      '30.1.2',
    ]) {
      expect(nodeIsPatched(v), v).toBe(true);
    }
  });

  it('flags a release before the fix on its line, an odd line and an older line', () => {
    for (const v of [
      '22.12.0',
      '22.23.3',
      '23.11.0',
      '24.21.0',
      'v24.22.0',
      '25.9.0',
      '26.12.0',
      '20.19.0',
    ]) {
      expect(nodeIsPatched(v), v).toBe(false);
    }
  });

  it('passes a version it cannot read', () => {
    expect(nodeIsPatched('nightly')).toBe(true);
  });
});

describe('warnUnpatchedNode', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes one line naming the version and the releases to update to', () => {
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    warnUnpatchedNode('24.21.0');
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(`${nodeUpdateNote('24.21.0')}\n`);
    expect(nodeUpdateNote('v24.21.0')).toBe(
      'warning: Node 24.21.0 lacks the Node security fixes of 21 October 2026, update to Node 22.23.4, 24.22.1 or 26.12.1, or a newer release of the same line',
    );
  });

  it('writes nothing on a patched Node', () => {
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    warnUnpatchedNode('24.22.1');
    expect(write).not.toHaveBeenCalled();
  });
});
