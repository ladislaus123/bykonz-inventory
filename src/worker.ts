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
import type { EmbeddingClient } from './embeddings/EmbeddingClient.js';
import type { WhatsAppFlow } from './flow.js';
import { log, logErr } from './log.js';
import type { Repository } from './repository/Repository.js';
import type { Storage } from './storage/Storage.js';
import type { Channel } from './transport/MessageTransport.js';
import type { Job, JobType } from './types/domain.js';

/** Job kinds this worker knows how to run; others are left for future workers. */
const HANDLED: ReadonlySet<JobType> = new Set<JobType>([
  'extract_card',
  'enrich_text',
  'embed_media',
  'add_contact',
]);

export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly repo: Repository,
    private readonly agent: EnrichmentAgent,
    private readonly flow: WhatsAppFlow,
    private readonly storage: Storage,
    private readonly embeddings: EmbeddingClient,
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
        if (!HANDLED.has(job.job)) continue; // other job types: later
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
      switch (job.job) {
        case 'extract_card':
          await this.runCardExtraction(job);
          break;
        case 'enrich_text':
          await this.runTextEnrichment(job);
          break;
        case 'embed_media':
          await this.runMediaEmbedding(job);
          break;
        case 'add_contact':
          await this.runAddContact(job);
          break;
        default:
          throw new Error(`worker cannot handle job type ${job.job}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.repo.markJobFailed(job.id, msg, { retry: true });
      logErr('worker', `job ${job.id} failed (will retry): ${msg}`, err);
    }
  }

  /** Flow 1: card/brochure photo(s) -> vision agent -> proposal. */
  private async runCardExtraction(job: Job): Promise<void> {
    if (!job.entityId) throw new Error('extract_card job missing entityId');

    // One card may have several photos (front + back, extra angles). Newer jobs
    // carry every media id in payload.mediaIds; older ones only entityMediaId.
    const payloadIds = Array.isArray(job.payload.mediaIds)
      ? (job.payload.mediaIds as string[]).filter((id) => typeof id === 'string')
      : [];
    const mediaIds = payloadIds.length ? payloadIds : job.entityMediaId ? [job.entityMediaId] : [];
    if (mediaIds.length === 0) throw new Error('extract_card job has no media to read');

    // storage_url holds the object path; sign each so the model can fetch them.
    const imageUrls: string[] = [];
    for (const id of mediaIds) {
      const media = await this.repo.getMediaById(id);
      if (!media) {
        logErr('worker', `job ${job.id}: media ${id} not found, skipping`);
        continue;
      }
      imageUrls.push(await this.storage.getSignedUrl(media.storageUrl, 600));
    }
    if (imageUrls.length === 0) throw new Error('extract_card job: none of its media could be resolved');
    log('worker', `job ${job.id}: ${imageUrls.length} signed image URL(s) ready, running agent…`);

    const result = await this.agent.run({ entityId: job.entityId, imageUrls });
    log('worker', `job ${job.id}: agent finished name="${result.name}"`);

    await this.sendProposal(job, result);
    await this.repo.markJobDone(job.id, { name: result.name });
    log('worker', `job ${job.id} done: ${result.name}`);
  }

  /** Adicionar: free-text description -> text agent -> proposal. */
  private async runTextEnrichment(job: Job): Promise<void> {
    if (!job.entityId) throw new Error('enrich_text job missing entityId');
    const text = String(job.payload.text ?? '');
    if (!text.trim()) throw new Error('enrich_text job missing payload.text');

    const result = await this.agent.run({ entityId: job.entityId, text });
    log('worker', `job ${job.id}: text agent finished name="${result.name}"`);

    await this.sendProposal(job, result);
    await this.repo.markJobDone(job.id, { name: result.name });
    log('worker', `job ${job.id} done: ${result.name}`);
  }

  /** Adicionar: uploaded business image -> multimodal embedding stored on the media row. */
  private async runMediaEmbedding(job: Job): Promise<void> {
    if (!job.entityMediaId) throw new Error('embed_media job missing entityMediaId');
    const media = await this.repo.getMediaById(job.entityMediaId);
    if (!media) throw new Error(`media ${job.entityMediaId} not found`);

    const signedUrl = await this.storage.getSignedUrl(media.storageUrl, 600);
    const res = await fetch(signedUrl);
    if (!res.ok) throw new Error(`fetch media bytes failed: ${res.status} ${res.statusText}`);
    const data = Buffer.from(await res.arrayBuffer());
    const mimeType = media.mimeType ?? res.headers.get('content-type') ?? 'image/jpeg';

    const vec = await this.embeddings.embedImage(data, mimeType);
    await this.repo.setMediaEmbedding(media.id, vec, this.embeddings.model);
    await this.repo.markJobDone(job.id, { mediaId: media.id, dims: vec.length });
    log('worker', `job ${job.id} done: embedded media ${media.id} (${vec.length} dims)`);
  }

  /** Adicionar contato: extract contact(s) from free text/voice OR a card photo. */
  private async runAddContact(job: Job): Promise<void> {
    if (!job.entityId) throw new Error('add_contact job missing entityId');
    const text = String(job.payload.text ?? '');
    const chatId = String(job.payload.chatId ?? '');
    const channel: Channel = job.payload.channel === 'telegram' ? 'telegram' : 'whatsapp';
    const entityName = String(job.payload.entityName ?? '') || (await this.entityName(job.entityId));

    // Photo path: sign the stored card image(s) so the agent can read them.
    const mediaIds = Array.isArray(job.payload.mediaIds)
      ? (job.payload.mediaIds as string[]).filter((id) => typeof id === 'string')
      : [];
    const imageUrls: string[] = [];
    for (const id of mediaIds) {
      const media = await this.repo.getMediaById(id);
      if (media) imageUrls.push(await this.storage.getSignedUrl(media.storageUrl, 600));
    }

    const contacts = await this.agent.extractContacts(
      imageUrls.length ? { imageUrls } : { text },
    );
    for (const c of contacts) {
      await this.repo.createContact({ entityId: job.entityId, source: 'manual', ...c });
    }
    log('worker', `job ${job.id}: added ${contacts.length} contact(s) to entity ${job.entityId}`);

    if (chatId) await this.flow.announceContactsSaved(chatId, channel, contacts.length, entityName);
    await this.repo.markJobDone(job.id, { contacts: contacts.length });
  }

  /** Best-effort lookup of an entity's name for the confirmation message. */
  private async entityName(entityId: string): Promise<string> {
    const entity = await this.repo.getEntityById(entityId).catch(() => null);
    return entity?.name ?? 'negócio';
  }

  /** Shared: ask the user to confirm the proposed entity (Aceitar / Recusar). */
  private async sendProposal(job: Job, result: { name: string; summary: string }): Promise<void> {
    const chatId = String(job.payload.chatId ?? '');
    if (!chatId) {
      logErr('worker', `job ${job.id}: no chatId in payload, skipping proposal`);
      return;
    }
    // Route the proposal back on the channel the request came in on (older jobs
    // predating multi-channel default to WhatsApp).
    const channel: Channel = job.payload.channel === 'telegram' ? 'telegram' : 'whatsapp';
    await this.flow.presentProposal(job.userId, chatId, channel, job.entityId!, result);
    log('worker', `job ${job.id}: proposal sent to ${chatId} on ${channel}`);
  }
}
