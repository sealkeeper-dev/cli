// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
// The fingerprint vectors from @sealkeeper/schema, hashed by the copy of the
// schema bundled into the CLI. The API
// (apps/api/src/fingerprint-conformance.test.ts) and the web
// (apps/web/lib/fingerprint-conformance.test.ts) run the same vectors, so
// a fingerprint the CLI makes hashes the same wherever it is read.
import { fingerprintHash, partHash } from '@sealkeeper/schema';
import {
  FINGERPRINT_VECTORS,
  PART_HASH_VECTORS,
} from '@sealkeeper/schema/conformance';
import { describe, expect, it } from 'vitest';

describe('fingerprint vectors in the CLI', () => {
  for (const vector of PART_HASH_VECTORS) {
    it(`partHash of ${vector.name}`, async () => {
      expect(await partHash(vector.sub, vector.content)).toBe(vector.hash);
    });
  }
  for (const vector of FINGERPRINT_VECTORS) {
    it(`fingerprintHash of ${vector.name}`, async () => {
      expect(await fingerprintHash(vector.parts)).toBe(vector.hash);
    });
  }
});
