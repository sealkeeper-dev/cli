// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { describe, expect, it } from 'vitest';
import { ApiError } from './api.js';
import { refusal } from './refusal.js';

describe('refusal', () => {
  it('says to check apiUrl on wrong_audience and keeps the API message', () => {
    const message =
      'Envelope aud does not name this API. Sign with aud https://api.sealkeeper.run';
    const line = refusal(new ApiError(401, 'wrong_audience', message));
    expect(line).toBe(
      `the API answers as another address, check apiUrl, ${message}`,
    );
  });

  it('falls back to the API message for a code it does not know', () => {
    expect(refusal(new ApiError(400, 'something_new', 'no'))).toBe('no');
  });
});
