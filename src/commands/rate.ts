// Copyright 2026 Carel Meyer. Licensed under the Apache License, Version 2.0.
import {
  AgentId,
  Dimension,
  RatingRequest,
  type RatingResponse,
  RatingValue,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import { ApiError } from '../api.js';
import { stdout, wantsJson } from '../output.js';
import {
  defaultTasksDeps,
  openTaskSession,
  printFields,
  type TasksDeps,
} from '../tasks.js';

// rate talks to the API the same way the task commands do, so it takes the
// same injectable fetch.
export type RateDeps = TasksDeps;

export const RATINGS_CLOSED = 'ratings are not open yet';

type RateOptions = { dimension: string; value: string };

export function register(
  parent: Command,
  deps: RateDeps = defaultTasksDeps,
): Command {
  return parent
    .command('rate <agent-id>')
    .description('Rate another agent on one dimension')
    .requiredOption(
      '--dimension <dimension>',
      'reliability, safety, cost_latency, provenance or competence:<task_type>',
    )
    .requiredOption('--value <n>', 'a whole number from 1 to 5')
    .action(async function (
      this: Command,
      agentId: string,
      options: RateOptions,
    ): Promise<void> {
      const request = validate(this, agentId, options);

      const { signer, api } = await openTaskSession(this, deps);
      let rating: RatingResponse;
      try {
        rating = await api.postRating(await signer.sign(request));
      } catch (error) {
        if (error instanceof ApiError) this.error(refusal(error, agentId));
        throw error;
      }

      if (wantsJson(this)) {
        stdout(JSON.stringify(rating));
        return;
      }
      printFields([
        ['agent', rating.rateeAgentId],
        ['dimension', rating.dimension],
        ['value', String(rating.value)],
        ['weight', String(rating.raterScoreAtTime)],
      ]);
    });
}

// Checked with the shared schemas before the key is loaded or anything is
// signed, so a bad argument never reaches the network. issuedAt is signed
// with the rating, so the API can refuse an old envelope sent again.
function validate(
  cmd: Command,
  agentId: string,
  options: RateOptions,
): RatingRequest {
  if (!AgentId.safeParse(agentId).success) {
    cmd.error(`not an agent id: ${agentId}`);
  }
  if (!Dimension.safeParse(options.dimension).success) {
    cmd.error(
      `--dimension must be reliability, safety, cost_latency, provenance or competence:<task_type>, got ${options.dimension}`,
    );
  }
  const value = /^\d+$/.test(options.value) ? Number(options.value) : NaN;
  if (!RatingValue.safeParse(value).success) {
    cmd.error(
      `--value must be a whole number from 1 to 5, got ${options.value}`,
    );
  }
  return RatingRequest.parse({
    rateeAgentId: agentId,
    dimension: options.dimension,
    value,
    issuedAt: new Date().toISOString(),
  });
}

// One line per refusal. The API message is the fallback for codes this
// version does not know.
function refusal(error: ApiError, agentId: string): string {
  switch (error.code) {
    case 'ratings_closed':
      return RATINGS_CLOSED;
    case 'self_rating':
      return 'an agent cannot rate itself';
    case 'not_found':
      return `no agent with id ${agentId}`;
    case 'rater_below_minimum':
      return 'your agent needs a higher score before it can rate others';
    case 'issued_at_out_of_window':
      return 'the API refused the rating time, check this machine clock';
    case 'stale_rating':
      return 'a newer rating for this agent and dimension is already stored';
    case 'rate_limited':
      return error.retryAfterSec === null
        ? 'too many ratings, try again later'
        : `too many ratings, try again in ${error.retryAfterSec} seconds`;
    case 'unknown_agent':
      return 'this agent is not registered, run vouched init';
    default:
      return error.message;
  }
}
