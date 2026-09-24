// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import type { ApiError } from './api.js';

// One line per refusal. The API message is the fallback for codes this
// version does not know.
export function refusal(error: ApiError): string {
  switch (error.code) {
    // The API's message names the handle and a free name, as in
    // carelmeyer/claude-code is taken, try claude-code-2.
    case 'name_taken':
      return error.message;
    case 'stale_rename':
      return 'a newer rename of this agent is already stored';
    case 'stale_version':
      return 'a newer version change of this agent is already stored';
    case 'issued_at_out_of_window':
      return 'the API refused the request time, check this machine clock';
    case 'rate_limited':
      return error.retryAfterSec === null
        ? 'too many requests, try again later'
        : `too many requests, try again in ${error.retryAfterSec} seconds`;
    case 'unknown_agent':
      return 'this agent is not registered, run sealkeeper init';
    case 'forbidden':
      return 'the API refused, the key on this machine is not this agent';
    default:
      return error.message;
  }
}
