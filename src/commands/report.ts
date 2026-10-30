// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { createHash, randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import {
  AgentId,
  REPORT_CATEGORIES,
  REPORT_EVIDENCE_REF_TYPES,
  type REPORT_UPLOAD_CONTENT_TYPES,
  REPORT_UPLOAD_HOST,
  REPORT_UPLOAD_MAX_BYTES,
  SignedMyReportsPayload,
  SignedReportPayload,
  SignedReportUploadPayload,
} from '@sealkeeper/schema';
import type { Command } from 'commander';
import { type ApiClient, ApiError, apiErrorOf } from '../api.js';
import { parseHandle } from '../check.js';
import { PROFILE_BASE_URL } from '../config.js';
import { readGuardedBytes } from '../file-guard.js';
import type { Signer } from '../identity.js';
import { cli } from '../invocation.js';
import { containsPrivateKey, holdsPrivateKey } from '../key-guard.js';
import { JSON_FLAG, JSON_HELP, stdout, wantsJson } from '../output.js';
import { refusal } from '../refusal.js';
import {
  dropReport,
  dropUploads,
  fileKeyOf,
  keepUpload,
  keptUploads,
  reportIdFor,
} from '../report-pending.js';
import {
  AgentListingKind,
  AgentRenamedResponse,
  AgentResponse,
  agentHandle,
  type MyReportsAnswer,
  type ReportAnswer,
  type ReportUploadAnswer,
} from '../responses.js';
import {
  defaultTasksDeps,
  openTaskSession,
  printFields,
  type TasksDeps,
  utc,
} from '../tasks.js';

// sealkeeper report <target> files a report on an agent or a service as this
// agent, signed with its key, and sealkeeper report list prints the reports
// this agent filed. Every flag is checked, and every file read, before the
// key is loaded or anything is sent. Then the target is looked up on
// SealKeeper, each file is uploaded, and the report goes last.
//
// The same command run again after a failure is safe. The report id is
// random, kept in report-pending.ts under a key made with the home's secret
// from the API, the agent, the target, the category, the description, the
// references and the name, type and SHA-256 of each file, until SealKeeper
// confirms the filing. So a run after a failure or an answer that never
// came sends the same id, and SealKeeper answers the one it holds, while
// the same command after a confirmed filing is a new report. A changed
// command is a new report too. When SealKeeper answers that the id is in
// use, the kept id goes, so the next run files under a new one. Each file
// that went up is kept by its upload id until a report holding it is
// filed, so a run after a failure uploads only the files still missing,
// also when the description changed. When SealKeeper answers that a kept
// upload is not one it knows, or is evidence already, the kept uploads of
// the command go and every file is uploaded again, once, in the same run.

export const TARGET_HELP =
  'the agent id, the handle as in alice/claude-code or example.com/weather, or the page URL on sealkeeper.run of the agent or service';

// A report's evidence is the --evidence references and the --file uploads.
// A file is never named with --evidence, since --file uploads it.
const REF_TYPES = [
  ...new Set(Object.values(REPORT_EVIDENCE_REF_TYPES).flat()),
].filter((t) => t !== 'file');

type EvidenceKind = keyof typeof REPORT_EVIDENCE_REF_TYPES;
type Evidence = { kind: EvidenceKind; refType: string; refValue: string };

// The kind of a reference. A ref_type one kind takes is that kind's, and a
// URL, which two kinds take, is other evidence, a link the reporter gives.
export function evidenceKind(refType: string): EvidenceKind {
  const kinds = (
    Object.entries(REPORT_EVIDENCE_REF_TYPES) as [
      EvidenceKind,
      readonly string[],
    ][]
  )
    .filter(([, types]) => types.includes(refType))
    .map(([kind]) => kind);
  return kinds.length === 1 ? (kinds[0] as EvidenceKind) : 'other';
}

type ContentType = (typeof REPORT_UPLOAD_CONTENT_TYPES)[number];

// The content type a file is sent as, by its extension.
const CONTENT_TYPES: Record<string, ContentType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/plain',
  '.csv': 'text/plain',
  '.json': 'application/json',
};
const EXTENSIONS = Object.keys(CONTENT_TYPES);

const UPLOAD_TIMEOUT_MS = 120_000;

export const KEY_IN_REPORT =
  "refusing to report, the report contains this agent's private key";

type ReportOptions = {
  category?: string;
  description?: string;
  evidence?: string[];
  file?: string[];
  allowOutsideCwd?: boolean;
};

type EvidenceFile = {
  path: string;
  fileName: string;
  contentType: ContentType;
  bytes: Buffer;
  // The SHA-256 of bytes, hex, for the report id.
  sha256: string;
};

type Target = { kind: 'agent' | 'service'; id: string; handle: string };

const collect = (value: string, previous: string[] = []): string[] => [
  ...previous,
  value,
];

export function register(
  parent: Command,
  deps: TasksDeps = defaultTasksDeps,
): Command {
  const report = parent
    .command('report')
    .description(
      'Report an agent or a service for harm, as this agent. Running the same command again after a failure is safe, it files the report once and sends only the files still missing. Once a report is filed, the same command files a new one. list prints the reports it filed',
    )
    .argument('<target>', TARGET_HELP)
    .option('--category <category>', `one of ${REPORT_CATEGORIES.join(', ')}`)
    .option('--description <text>', 'what happened, in your own words')
    .option(
      '--evidence <ref_type=value>',
      `a reference, ref_type one of ${REF_TYPES.join(', ')}, repeatable`,
      collect,
    )
    .option(
      '--file <path>',
      `a file to upload as evidence, ${EXTENSIONS.join(', ')}, repeatable`,
      collect,
    )
    .option(
      '--allow-outside-cwd',
      'let --file read outside the current directory',
    )
    .option(JSON_FLAG, JSON_HELP)
    .action(async function (
      this: Command,
      target: string,
      options: ReportOptions,
    ): Promise<void> {
      await fileReport(this, deps, target, options);
    });

  report
    .command('list')
    .description('List the reports this agent filed, with status and reasons')
    .option('--cursor <cursor>', 'the next page, as the last list printed it')
    .action(async function (
      this: Command,
      options: { cursor?: string },
    ): Promise<void> {
      await listReports(this, deps, options);
    });

  return report;
}

async function fileReport(
  cmd: Command,
  deps: TasksDeps,
  target: string,
  options: ReportOptions,
): Promise<void> {
  const ref = targetRef(cmd, target);
  const category = options.category;
  if (category === undefined) {
    cmd.error(`--category is needed, one of ${REPORT_CATEGORIES.join(', ')}`);
  }
  if (!(REPORT_CATEGORIES as readonly string[]).includes(category)) {
    cmd.error(
      `--category must be one of ${REPORT_CATEGORIES.join(', ')}, got ${category}`,
    );
  }
  if (options.description === undefined) {
    cmd.error('--description is needed, say what happened');
  }
  const evidence = parseEvidence(cmd, options.evidence ?? []);
  const files: EvidenceFile[] = [];
  for (const path of options.file ?? []) {
    files.push(await readEvidenceFile(cmd, path, options.allowOutsideCwd));
  }
  // Checked once with a stand in id for each file, so a bad description or
  // too much evidence ends here, before anything is uploaded.
  const fields = (ids: string[]) => ({
    category,
    description: options.description,
    evidence: [
      ...evidence,
      ...ids.map((id) => ({ kind: 'other', refType: 'file', refValue: id })),
    ],
  });
  const draft = SignedReportPayload.pick({
    category: true,
    description: true,
    evidence: true,
  }).safeParse(fields(files.map(() => randomUUID())));
  if (!draft.success) cmd.error(issueLine(draft.error.issues[0], options));
  if (await holdsPrivateKey({ description: options.description, evidence })) {
    cmd.error(KEY_IN_REPORT);
  }

  const { signer, api } = await openTaskSession(cmd, deps);
  const subject = await resolveTarget(cmd, api, ref, target);
  const fileKeys = files.map((f) =>
    fileKeyOf([api.apiUrl, f.fileName, f.contentType, f.sha256]),
  );
  const { key: reportKey, reportId } = await reportIdFor([
    api.apiUrl,
    signer.agentId,
    subject.kind,
    subject.id,
    category,
    options.description,
    evidence,
    fileKeys,
  ]);

  // Uploads each file not in kept, keeping its id once it went up, then
  // files the report with every upload id. A file given twice is uploaded
  // once for each, since one upload is evidence once.
  const send = async (kept: (string | null)[]): Promise<ReportAnswer> => {
    const uploadIds: string[] = [];
    for (const [i, file] of files.entries()) {
      let id = kept[i] ?? null;
      if (id === null || uploadIds.includes(id)) {
        id = await upload(cmd, deps, signer, api, file);
        await keepUpload(fileKeys[i] as string, id);
      }
      uploadIds.push(id);
    }
    const request = SignedReportPayload.parse({
      reportId,
      targetKind: subject.kind,
      targetId: subject.id,
      ...fields(uploadIds),
      surface: 'cli',
      issuedAt: new Date().toISOString(),
    });
    return api.fileReport(await signer.sign(request, 'report.file'));
  };
  const refused = async (error: unknown): Promise<never> => {
    if (error instanceof ApiError) {
      if (error.code === 'report_id_taken') await dropReport(reportKey);
      cmd.error(reportRefusal(error, options));
    }
    throw error;
  };

  const kept = await keptUploads(fileKeys);
  let filed: ReportAnswer;
  try {
    filed = await send(kept);
  } catch (error) {
    if (!keptUploadRefused(error, kept, evidence.length)) {
      return refused(error);
    }
    await dropUploads(fileKeys);
    filed = await send(files.map(() => null)).catch(refused);
  }
  // Filed, so the same command from here on is a new report.
  await dropReport(reportKey);
  await dropUploads(fileKeys);

  if (wantsJson(cmd)) {
    stdout(JSON.stringify(filed));
    return;
  }
  printFields([
    ['report', filed.id],
    ['target', `${subject.handle}, ${subject.kind}`],
    ['category', filed.category],
    ['status', filed.status],
    ...(filed.disclosureAt
      ? ([['not public before', utc(filed.disclosureAt)]] as [string, string][])
      : []),
  ]);
  stdout(`See where it stands with ${cli('report list')}`);
}

// What target names, checked before anything is sent. An agent id, a
// handle, or a page URL on the SealKeeper site, read as the id or the handle
// at the start of its path, so a page below it, such as its duels, names
// the same agent.
type TargetRef = { id: string } | { slug: string; name: string };

export function targetRef(cmd: Command, value: string): TargetRef {
  const notOne = (): never =>
    cmd.error(`${value} is not an agent or a service, use ${TARGET_HELP}`);
  if (AgentId.safeParse(value).success) return { id: value };
  let path = value;
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return notOne();
    }
    const site = new URL(PROFILE_BASE_URL);
    if (url.origin !== site.origin || !url.pathname.startsWith('/agents/')) {
      return notOne();
    }
    let parts: string[];
    try {
      parts = url.pathname
        .slice('/agents/'.length)
        .split('/')
        .filter((p) => p !== '')
        .map((p) => decodeURIComponent(p));
    } catch {
      return notOne();
    }
    if (AgentId.safeParse(parts[0]).success) {
      return { id: parts[0] as string };
    }
    if (parts.length < 2) return notOne();
    path = parts.slice(0, 2).join('/');
  }
  if (!path.includes('/')) return notOne();
  try {
    return parseHandle(path);
  } catch (error) {
    if (error instanceof ApiError) cmd.error(error.message);
    throw error;
  }
}

// The agent or the service ref names, as SealKeeper has it. A service is
// told apart by the listing its answer carries.
async function resolveTarget(
  cmd: Command,
  api: ApiClient,
  ref: TargetRef,
  value: string,
): Promise<Target> {
  const path =
    'id' in ref
      ? `/v1/agents/${encodeURIComponent(ref.id)}`
      : `/v1/agents/${encodeURIComponent(ref.slug)}/${encodeURIComponent(ref.name)}`;
  let agent: AgentResponse;
  let service = false;
  try {
    const { status, json, headers } = await api.request(path);
    const renamed = AgentRenamedResponse.safeParse(json);
    if (status === 404 && renamed.success && !('id' in ref)) {
      cmd.error(
        `${ref.slug}/${ref.name} is now ${renamed.data.handle}, report it by that handle`,
      );
    }
    const parsed = AgentResponse.safeParse(json);
    if (status !== 200 || !parsed.success) {
      throw apiErrorOf(status, status === 200 ? undefined : json, headers);
    }
    agent = parsed.data;
    service =
      AgentListingKind.safeParse(json).data?.listing?.subjectKind === 'service';
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.code === 'not_found' || error.code === 'gone') {
      cmd.error(`no agent or service ${value} on SealKeeper`);
    }
    cmd.error(refusal(error));
  }
  return {
    kind: service ? 'service' : 'agent',
    id: agent.id,
    handle: agentHandle(agent),
  };
}

// Each --evidence as <ref_type>=<value>, split at the first =.
function parseEvidence(cmd: Command, values: string[]): Evidence[] {
  return values.map((value) => {
    const at = value.indexOf('=');
    const refType = at === -1 ? '' : value.slice(0, at).trim();
    if (!REF_TYPES.includes(refType as (typeof REF_TYPES)[number])) {
      cmd.error(
        `--evidence takes <ref_type>=<value>, ref_type one of ${REF_TYPES.join(', ')}, got ${value}`,
      );
    }
    return {
      kind: evidenceKind(refType),
      refType,
      refValue: value.slice(at + 1).trim(),
    };
  });
}

// One --file, by the rules in file-guard.ts, as submit --file reads an
// answer, and at most the size an upload takes. Nothing is read from a
// refused file.
async function readEvidenceFile(
  cmd: Command,
  path: string,
  allowOutsideCwd: boolean | undefined,
): Promise<EvidenceFile> {
  const contentType = CONTENT_TYPES[extname(path).toLowerCase()];
  if (contentType === undefined) {
    cmd.error(
      `refusing to send ${path}, a file goes as ${EXTENSIONS.join(', ')}`,
    );
  }
  const read = await readGuardedBytes(path, {
    maxBytes: REPORT_UPLOAD_MAX_BYTES,
    refusing: 'refusing to send',
    what: 'the evidence file',
    allowOutsideCwd: allowOutsideCwd === true,
  });
  if ('error' in read) cmd.error(read.error);
  if (read.bytes.length === 0)
    cmd.error(`refusing to send ${path}, it is empty`);
  if (await containsPrivateKey(read.bytes.toString('latin1'))) {
    cmd.error(`refusing to send ${path}, it contains this agent's private key`);
  }
  const fileName = basename(path);
  const declared = SignedReportUploadPayload.safeParse({
    fileName,
    contentType,
    sizeBytes: read.bytes.length,
    issuedAt: new Date().toISOString(),
  });
  if (!declared.success) {
    cmd.error(
      `refusing to send ${path}, ${declared.error.issues[0]?.message ?? 'its name cannot be sent'}`,
    );
  }
  return {
    path,
    fileName,
    contentType,
    bytes: read.bytes,
    sha256: createHash('sha256').update(read.bytes).digest('hex'),
  };
}

// Whether SealKeeper refused a filing for an upload a run before kept,
// one it holds no upload of this agent for, or one that is evidence
// already. The evidence is the references first, then the files.
function keptUploadRefused(
  error: unknown,
  kept: (string | null)[],
  refs: number,
): boolean {
  if (!(error instanceof ApiError) || kept.every((id) => id === null)) {
    return false;
  }
  if (error.code === 'upload_used') return true;
  return (
    error.code === 'evidence_not_found' &&
    error.issues.some((issue) => {
      const [field, index] = issue.path;
      return (
        field === 'evidence' &&
        typeof index === 'number' &&
        (kept[index - refs] ?? null) !== null
      );
    })
  );
}

// Asks for a signed upload URL for file, then sends the file there with
// exactly the headers the answer names. Returns the upload id.
async function upload(
  cmd: Command,
  deps: TasksDeps,
  signer: Signer,
  api: ApiClient,
  file: EvidenceFile,
): Promise<string> {
  const request = SignedReportUploadPayload.parse({
    fileName: file.fileName,
    contentType: file.contentType,
    sizeBytes: file.bytes.length,
    issuedAt: new Date().toISOString(),
  });
  let answer: ReportUploadAnswer;
  try {
    answer = await api.reportUpload(
      await signer.sign(request, 'report.upload'),
    );
  } catch (error) {
    if (error instanceof ApiError) cmd.error(refusal(error));
    throw error;
  }
  const failed = (why: string) =>
    cmd.error(`could not upload ${file.path}, ${why}`);
  if (new URL(answer.upload.url).host !== REPORT_UPLOAD_HOST) {
    failed(`the upload address is not ${REPORT_UPLOAD_HOST}`);
  }
  let res: Response;
  try {
    res = await deps.fetch(answer.upload.url, {
      method: answer.upload.method,
      headers: answer.upload.headers,
      body: file.bytes,
      redirect: 'manual',
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    return failed((error as Error).message);
  }
  if (res.status < 200 || res.status > 299) {
    failed(`the upload answered HTTP ${res.status}`);
  }
  return answer.uploadId;
}

// One line per refusal of a filing the agent can act on. Codes every
// signed command shares fall through to refusal.
const REPORT_MESSAGES: Record<
  string,
  (error: ApiError, options: ReportOptions) => string
> = {
  // One issue per reference SealKeeper holds no record of.
  evidence_not_found: (error, options) =>
    error.issues.length === 0
      ? error.message
      : error.issues.map((issue) => issueLine(issue, options)).join('\n'),
  validation_failed: (error, options) =>
    error.issues[0] ? issueLine(error.issues[0], options) : error.message,
  report_id_taken: () =>
    'this report id is in use, run the same command again to file it under a new one',
};

function reportRefusal(error: ApiError, options: ReportOptions): string {
  const known = REPORT_MESSAGES[error.code];
  return known ? known(error, options) : refusal(error);
}

// One issue of a report's fields as the flag that gave it. The evidence is
// the --evidence references in order, then the --file uploads.
function issueLine(
  issue: { path: PropertyKey[]; message: string } | undefined,
  options: ReportOptions,
): string {
  if (issue === undefined) return 'the report cannot be sent';
  const [field, index] = issue.path;
  const message = lowerFirst(issue.message);
  if (field === 'evidence' && typeof index === 'number') {
    const refs = options.evidence ?? [];
    const flag =
      index < refs.length
        ? `--evidence ${refs[index]}`
        : `--file ${(options.file ?? [])[index - refs.length] ?? ''}`;
    return `${flag}, ${message}`;
  }
  if (field === 'evidence') return `${message}, as --evidence or --file`;
  return `--${String(field ?? 'report')}, ${message}`;
}

// A schema's message inside a line, as in a task id is a UUID.
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

async function listReports(
  cmd: Command,
  deps: TasksDeps,
  options: { cursor?: string },
): Promise<void> {
  const parsed = SignedMyReportsPayload.safeParse({
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    issuedAt: new Date().toISOString(),
  });
  if (!parsed.success) {
    cmd.error(`--cursor is not one the list printed, got ${options.cursor}`);
  }
  // The cursor goes back as the list printed it. The parse above checked it.
  const request = {
    limit: parsed.data.limit,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    issuedAt: parsed.data.issuedAt,
  };
  const { signer, api } = await openTaskSession(cmd, deps);
  let page: MyReportsAnswer;
  try {
    page = await api.myReports(await signer.sign(request, 'report.mine'));
  } catch (error) {
    if (error instanceof ApiError) cmd.error(reportRefusal(error, {}));
    throw error;
  }

  if (wantsJson(cmd)) {
    stdout(JSON.stringify(page));
    return;
  }
  if (page.reports.length === 0) {
    stdout('this agent has filed no reports');
    return;
  }
  page.reports.forEach((r, i) => {
    if (i > 0) stdout('');
    printFields([
      ['report', r.id],
      ['filed', utc(r.createdAt)],
      ['target', `${r.target.kind} ${r.target.id}`],
      ['category', r.category],
      ['status', r.status],
      ...(r.decisionReason
        ? ([['reason', r.decisionReason]] as [string, string][])
        : []),
      ...(r.publishedAt
        ? ([['public', utc(r.publishedAt)]] as [string, string][])
        : []),
    ]);
  });
  if (page.nextCursor) {
    stdout('');
    stdout(
      `Older reports follow, run ${cli(`report list --cursor ${page.nextCursor}`)}`,
    );
  }
}
