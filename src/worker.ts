/**
 * Worker — drains the `jobs` table and runs the enrichment agent.
 *
 * For each pending `extract_card` job it: loads the media, mints a short-lived
 * signed URL, runs the agent (which writes the entity + embeds the description),
 * then messages the user the proposal with Aceitar / Recusar buttons.
 *
 * markJobRunning flips status out of 'pending', so a job is picked up once even
 * across overlapping ticks. (A crash mid-job leaves it 'running'; a reaper for
 * stale running jobs is a v2 concern.)
 */

import type { EnrichmentAgent } from './agent/EnrichmentAgent.js';
import type { WhatsAppFlow } from './flow.js';
import { log, logErr } from './log.js';
import type { Repository } from './repository/Repository.js';
import type { Storage } from './storage/Storage.js';
import type { Job } from './types/domain.js';

export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly repo: Repository,
    private readonly agent: EnrichmentAgent,
    private readonly flow: WhatsAppFlow,
    private readonly storage: Storage,
    private readonly pollMs = 3000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    log('worker', `started (poll every ${this.pollMs}ms)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return; // avoid overlapping runs
    this.ticking = true;
    try {
      const jobs = await this.repo.listPendingJobs(10);
      for (const job of jobs) {
        if (job.job !== 'extract_card') continue; // other job types: later
        await this.process(job);
      }
    } catch (err) {
      logErr('worker', 'tick failed', err);
    } finally {
      this.ticking = false;
    }
  }

  private async process(job: Job): Promise<void> {
    log('worker', `picked up job ${job.id} (${job.job}) entity=${job.entityId}`);
    await this.repo.markJobRunning(job.id);
    try {
      if (!job.entityId || !job.entityMediaId) {
        throw new Error('extract_card job missing entityId/entityMediaId');
      }
      const media = await this.repo.getMediaById(job.entityMediaId);
      if (!media) throw new Error(`media ${job.entityMediaId} not found`);

      // storage_url holds the object path; sign it so the model can fetch it.
      const imageUrl = await this.storage.getSignedUrl(media.storageUrl, 600);
      log('worker', `job ${job.id}: signed image URL ready, running agent…`);

      const result = await this.agent.run({ entityId: job.entityId, imageUrl });
      log('worker', `job ${job.id}: agent finished name="${result.name}"`);

      const chatId = String(job.payload.chatId ?? '');
      if (chatId) {
        await this.flow.presentProposal(chatId, job.entityId, result);
        log('worker', `job ${job.id}: proposal sent to ${chatId}`);
      } else {
        logErr('worker', `job ${job.id}: no chatId in payload, skipping proposal`);
      }

      await this.repo.markJobDone(job.id, { name: result.name });
      log('worker', `job ${job.id} done: ${result.name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.repo.markJobFailed(job.id, msg, { retry: true });
      logErr('worker', `job ${job.id} failed (will retry): ${msg}`, err);
    }
  }
}
