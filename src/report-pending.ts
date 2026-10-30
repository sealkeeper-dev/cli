// Copyright 2026 The SealKeeper Authors. Licensed under the Apache License, Version 2.0.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { z } from 'zod';
import { ensureHome, type Paths, paths, writeFileAtomic } from './config.js';
import { ensurePromptSecret } from './prompt-secret.js';

// What makes sealkeeper report safe to run again. A report gets a random id,
// kept here under a key made from the report itself with this home's
// secret, before it is sent and until SealKeeper confirms it filed it. So a
// run after a failure or an answer that never came sends the same id, and
// SealKeeper answers the report it already holds, while a run after the
// filing was confirmed finds no id and files a new report. No one without
// the secret can check a guess of a report's parts against its key. Each
// file that went up is kept here by its upload id until a report holding it
// is filed, so a run after a failure, also one with a changed description,
// sends only the files still missing. A file is kept only once its upload
// finished, never before, so a kept id always names a file that went up.
// Reports and files never filed, such as a command that was changed, are
// dropped past the newest MAX_KEPT of each, so the file never grows past
// that.

const MAX_KEPT = 100;

// Kept apart from the fingerprint's use of the same secret.
const REPORT_KEY_LABEL = 'sealkeeper report key\n';

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);

// One report not confirmed yet, by reportKeyOf, and its report id.
const Report = z.object({ key: Hex64, reportId: z.uuid() });
type Report = z.infer<typeof Report>;

// One file that went up, by fileKeyOf, and its upload id.
const Kept = z.object({ file: Hex64, uploadId: z.uuid() });
type Kept = z.infer<typeof Kept>;

const PendingFile = z.object({
  v: z.literal(1),
  reports: z.array(Report),
  uploads: z.array(Kept),
});
type Pending = { reports: Report[]; uploads: Kept[] };

// The key a report is kept under, the HMAC-SHA256 of parts under the home's
// secret, hex. Null when the secret does not read.
async function reportKeyOf(parts: unknown, p: Paths): Promise<string | null> {
  let secret: string;
  try {
    secret = await ensurePromptSecret(p);
  } catch {
    return null;
  }
  return createHmac('sha256', secret)
    .update(REPORT_KEY_LABEL, 'utf8')
    .update(JSON.stringify(parts), 'utf8')
    .digest('hex');
}

// The report id for parts and the key it is kept under. The id kept for
// the same parts when there is one, else a random id, kept before it is
// returned. Either way it is kept as the newest, so a report still being
// run again is the last to go past MAX_KEPT. Never throws. When the secret
// does not read the key is null and the id is random. When the id cannot
// be kept the report is still filed, only not safe to run again.
export async function reportIdFor(
  parts: unknown,
  p: Paths = paths(),
): Promise<{ key: string | null; reportId: string }> {
  const key = await reportKeyOf(parts, p);
  if (key === null) return { key, reportId: randomUUID() };
  let reportId: string = randomUUID();
  try {
    const pending = await readPending(p);
    const found = pending.reports.find((r) => r.key === key);
    if (found) reportId = found.reportId;
    const rest = pending.reports.filter((r) => r.key !== key);
    await writePending(
      {
        ...pending,
        reports: [...rest, { key, reportId }].slice(-MAX_KEPT),
      },
      p,
    );
  } catch {
    // Not kept, or kept but not moved to the newest end.
  }
  return { key, reportId };
}

// Drops the report kept under key, once SealKeeper confirmed it filed it or
// once its id is not one SealKeeper takes. Never throws. When the drop
// fails after a filing, the same command run again sends the filed id and
// gets that report back, filing no new one.
export async function dropReport(
  key: string | null,
  p: Paths = paths(),
): Promise<void> {
  if (key === null) return;
  try {
    const pending = await readPending(p);
    const reports = pending.reports.filter((r) => r.key !== key);
    if (reports.length === pending.reports.length) return;
    await writePending({ ...pending, reports }, p);
  } catch {
    // Left in place.
  }
}

// The key a file is kept under, the SHA-256 of parts, which name the API
// and the file as it was declared.
export function fileKeyOf(parts: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(parts), 'utf8')
    .digest('hex');
}

async function readPending(p: Paths): Promise<Pending> {
  try {
    const parsed = PendingFile.safeParse(
      JSON.parse(await readFile(p.reportPending, 'utf8')),
    );
    if (parsed.success) {
      return { reports: parsed.data.reports, uploads: parsed.data.uploads };
    }
  } catch {
    // No record.
  }
  return { reports: [], uploads: [] };
}

async function writePending(pending: Pending, p: Paths): Promise<void> {
  if (pending.reports.length === 0 && pending.uploads.length === 0) {
    await rm(p.reportPending, { force: true });
    return;
  }
  await ensureHome(p);
  await writeFileAtomic(
    p.reportPending,
    `${JSON.stringify({ v: 1, reports: pending.reports, uploads: pending.uploads })}\n`,
  );
}

// The upload id kept for each file, null for one still to send.
export async function keptUploads(
  files: string[],
  p: Paths = paths(),
): Promise<(string | null)[]> {
  const { uploads } = await readPending(p);
  return files.map(
    (file) => uploads.find((k) => k.file === file)?.uploadId ?? null,
  );
}

// Keeps that file went up as uploadId. Never throws, and the worst case is
// a run after a failure that sends the file again.
export async function keepUpload(
  file: string,
  uploadId: string,
  p: Paths = paths(),
): Promise<void> {
  try {
    const pending = await readPending(p);
    const rest = pending.uploads.filter((k) => k.file !== file);
    await writePending(
      {
        ...pending,
        uploads: [...rest, { file, uploadId }].slice(-MAX_KEPT),
      },
      p,
    );
  } catch {
    // Not kept.
  }
}

// Drops the uploads of files, once a report holding them is filed or once
// SealKeeper no longer takes them. Never throws, and the worst case is an
// upload left until newer ones push it out.
export async function dropUploads(
  files: string[],
  p: Paths = paths(),
): Promise<void> {
  try {
    const pending = await readPending(p);
    const uploads = pending.uploads.filter((k) => !files.includes(k.file));
    if (uploads.length === pending.uploads.length) return;
    await writePending({ ...pending, uploads }, p);
  } catch {
    // Left in place.
  }
}
