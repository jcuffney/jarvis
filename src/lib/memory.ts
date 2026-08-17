import { appendFile, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Short-term memory tier: append-only JSONL, one file per day, on a small
 * PVC. The nightly dream-consolidator CronJob (homelab repo) distills these
 * into the brain vault and prunes them — jarvis only ever appends to today's
 * file, the consolidator only touches files that have gone quiet, so the two
 * writers never meet.
 *
 * DATA_DIR unset disables the whole tier (same degrade pattern as HA_TOKEN):
 * appends become no-ops and the API reports 503.
 */

const DATA_DIR = process.env.DATA_DIR ?? '';
// Labels day files with the household's day, not UTC's. en-CA is the locale
// trick that yields YYYY-MM-DD; Node's full-ICU resolves the zone without
// container tzdata.
const MEMORY_TZ = process.env.MEMORY_TZ ?? 'America/New_York';

const TRANSCRIPTS_DIR = join(DATA_DIR, 'transcripts');
const ARTIFACTS_DIR = join(DATA_DIR, 'artifacts');

export type MemorySource = 'tv' | 'ha-pipeline';

export interface TranscriptEntry {
  ts: string;
  source: MemorySource;
  conversationId?: string;
  user: string;
  assistant: string;
}

export interface ArtifactEntry {
  ts: string;
  source: MemorySource;
  text: string;
}

export const memoryEnabled = DATA_DIR !== '';

if (memoryEnabled) {
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

function dayKey(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: MEMORY_TZ });
}

// Memory failures must never surface into request handlers — an unwritable
// disk degrades to "assistant forgets", not "assistant breaks".
function append(dir: string, entry: TranscriptEntry | ArtifactEntry): void {
  if (!memoryEnabled) return;
  const file = join(dir, `${dayKey()}.jsonl`);
  appendFile(file, `${JSON.stringify(entry)}\n`, (err) => {
    if (err) console.error(`[memory] append to ${file} failed:`, err);
  });
}

export function appendTranscript(entry: TranscriptEntry): void {
  append(TRANSCRIPTS_DIR, entry);
}

export function appendArtifact(entry: ArtifactEntry): void {
  append(ARTIFACTS_DIR, entry);
}

function bytesToday(dir: string): number {
  const file = join(dir, `${dayKey()}.jsonl`);
  try {
    return existsSync(file) ? statSync(file).size : 0;
  } catch {
    return 0;
  }
}

function pendingDays(): number {
  // Day keys with raw (un-consolidated) JSONL, today included.
  const days = new Set<string>();
  for (const dir of [TRANSCRIPTS_DIR, ARTIFACTS_DIR]) {
    try {
      for (const name of readdirSync(dir)) {
        if (name.endsWith('.jsonl')) days.add(name.slice(0, -'.jsonl'.length));
      }
    } catch {
      // unreadable dir counts as zero rather than failing status
    }
  }
  return days.size;
}

export function memoryStatus(): {
  enabled: boolean;
  today?: string;
  transcriptBytesToday?: number;
  artifactBytesToday?: number;
  pendingDays?: number;
} {
  if (!memoryEnabled) return { enabled: false };
  return {
    enabled: true,
    today: dayKey(),
    transcriptBytesToday: bytesToday(TRANSCRIPTS_DIR),
    artifactBytesToday: bytesToday(ARTIFACTS_DIR),
    pendingDays: pendingDays(),
  };
}
