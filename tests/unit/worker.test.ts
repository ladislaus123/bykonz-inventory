import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { EnrichmentAgent } from '../../src/agent/EnrichmentAgent.js';
import type { EmbeddingClient } from '../../src/embeddings/EmbeddingClient.js';
import { ptBR } from '../../src/messages.pt-BR.js';
import type { Entity, User } from '../../src/types/domain.js';
import { Worker } from '../../src/worker.js';
import { useFetch } from '../helpers/fetch-mock.js';
import { harness, type Harness, CHAT } from '../helpers/harness.js';

class FakeAgent {
  runs: Array<{ entityId: string; text?: string; imageUrls: string[] }> = [];
  contactCalls: Array<{ text?: string; imageUrls?: string[] }> = [];
  contacts = [{ name: 'Ana', role: 'CEO' }];
  fail: Error | null = null;

  async run(input: { entityId: string; text?: string; imageUrl?: string; imageUrls?: string[] }) {
    if (this.fail) throw this.fail;
    const imageUrls = [...(input.imageUrls ?? []), ...(input.imageUrl ? [input.imageUrl] : [])];
    this.runs.push({ entityId: input.entityId, text: input.text, imageUrls });
    return { name: 'Padaria Sol', summary: 'Padaria no centro.' };
  }

  async extractContacts(input: { text?: string; imageUrls?: string[] }) {
    this.contactCalls.push(input);
    if (this.fail) throw this.fail;
    return this.contacts;
  }
}

function tick(worker: Worker): Promise<void> {
  return (worker as unknown as { tick(): Promise<void> }).tick();
}

async function seed(h: Harness): Promise<{ user: User; entity: Entity }> {
  const user = await h.repo.createUser({ name: 'Ana', waId: CHAT, contact: CHAT });
  const entity = await h.repo.createEntity({
    name: 'Novo cadastro',
    status: 'pending_review',
    createdBy: user.id,
  });
  return { user, entity };
}

async function store(h: Harness, entityId: string, key: string) {
  await h.storage.upload({ key, data: Buffer.from('img'), contentType: 'image/jpeg' });
  return h.repo.createMedia({ entityId, storageUrl: key, mimeType: 'image/jpeg', mediaType: 'image' });
}

describe('Worker', { concurrency: 1 }, () => {
  test('extract_card signs every photo, proposes the result, and marks the job done', async () => {
    const h = harness();
    const agent = new FakeAgent();
    const { user, entity } = await seed(h);
    await h.repo.updateEntity(entity.id, { phone: '119999' });
    const front = await store(h, entity.id, 'cards/front.jpg');
    const back = await store(h, entity.id, 'cards/back.jpg');
    const job = await h.repo.enqueueJob({
      userId: user.id,
      job: 'extract_card',
      entityId: entity.id,
      entityMediaId: front.id,
      payload: { chatId: CHAT, channel: 'whatsapp', mediaIds: [front.id, back.id, 'missing-media'] },
    });

    const worker = new Worker(h.repo, agent as unknown as EnrichmentAgent, h.flow, h.storage, h.embeddings as unknown as EmbeddingClient);
    await tick(worker);

    assert.equal(agent.runs.length, 1);
    assert.deepEqual(agent.runs[0]?.imageUrls.map((url) => url.split('/').at(-1)), ['front.jpg', 'back.jpg']);
    const done = await h.repo.getJobById(job.id);
    assert.equal(done?.status, 'done');
    assert.deepEqual(done?.result, { name: 'Padaria Sol' });
    const buttons = h.transport.sentButtons.at(-1);
    assert.match(buttons?.body ?? '', /Padaria Sol/);
    assert.match(buttons?.body ?? '', /119999/);
    assert.deepEqual(buttons?.buttons.map((b) => b.title), [ptBR.accept, ptBR.reject]);
    assert.equal((await h.repo.getConversationState(user.id)).state, 'awaiting_decision');
  });

  test('routes the proposal back to Telegram when that is the originating channel', async () => {
    const h = harness({ channels: ['whatsapp', 'telegram'] });
    const agent = new FakeAgent();
    const { user, entity } = await seed(h);
    const media = await store(h, entity.id, 'cards/front.jpg');
    await h.repo.enqueueJob({
      userId: user.id,
      job: 'extract_card',
      entityId: entity.id,
      entityMediaId: media.id,
      payload: { chatId: '42', channel: 'telegram', mediaIds: [media.id] },
    });
    const worker = new Worker(h.repo, agent as unknown as EnrichmentAgent, h.flow, h.storage, h.embeddings as unknown as EmbeddingClient);
    await tick(worker);
    assert.equal(h.transports.telegram?.sentButtons.length, 1);
    assert.equal(h.transports.whatsapp?.sentButtons.length ?? 0, 0);
  });

  test('completes a card job that has no chat to answer', async () => {
    const h = harness();
    const agent = new FakeAgent();
    const { user, entity } = await seed(h);
    const media = await store(h, entity.id, 'cards/front.jpg');
    const job = await h.repo.enqueueJob({
      userId: user.id,
      job: 'extract_card',
      entityId: entity.id,
      entityMediaId: media.id,
      payload: { mediaIds: [media.id] },
    });
    const worker = new Worker(h.repo, agent as unknown as EnrichmentAgent, h.flow, h.storage, h.embeddings as unknown as EmbeddingClient);
    await tick(worker);
    assert.equal((await h.repo.getJobById(job.id))?.status, 'done');
    assert.equal(h.transport.sentButtons.length, 0);
  });

  test('retries a card job when the agent throws, and leaves it unclaimable during backoff', async () => {
    const h = harness();
    const agent = new FakeAgent();
    agent.fail = new Error('model down');
    const { user, entity } = await seed(h);
    const media = await store(h, entity.id, 'cards/front.jpg');
    const job = await h.repo.enqueueJob({
      userId: user.id,
      job: 'extract_card',
      entityId: entity.id,
      entityMediaId: media.id,
      payload: { chatId: CHAT, channel: 'whatsapp', mediaIds: [media.id] },
    });
    const worker = new Worker(h.repo, agent as unknown as EnrichmentAgent, h.flow, h.storage, h.embeddings as unknown as EmbeddingClient);
    await tick(worker);
    const failed = await h.repo.getJobById(job.id);
    assert.equal(failed?.status, 'pending');
    assert.equal(failed?.attempts, 1);
    assert.match(failed?.error ?? '', /model down/);
    assert.ok((failed?.scheduledAt ?? '') > new Date().toISOString());
    assert.deepEqual(await h.repo.listPendingJobs(), []);
  });

  test('fails a card job whose media cannot be signed, and one with no media at all', async () => {
    const h = harness();
    const agent = new FakeAgent();
    const { user, entity } = await seed(h);
    const orphan = await h.repo.createMedia({ entityId: entity.id, storageUrl: 'cards/missing.jpg' });
    const unsigned = await h.repo.enqueueJob({
      userId: user.id,
      job: 'extract_card',
      entityId: entity.id,
      entityMediaId: orphan.id,
      payload: { chatId: CHAT, mediaIds: [orphan.id] },
    });
    const empty = await h.repo.enqueueJob({
      userId: user.id,
      job: 'extract_card',
      entityId: entity.id,
      payload: { chatId: CHAT, mediaIds: ['gone'] },
    });
    const worker = new Worker(h.repo, agent as unknown as EnrichmentAgent, h.flow, h.storage, h.embeddings as unknown as EmbeddingClient);
    await tick(worker);
    assert.match((await h.repo.getJobById(unsigned.id))?.error ?? '', /object not found|none of its media/);
    assert.match((await h.repo.getJobById(empty.id))?.error ?? '', /none of its media/);
    assert.equal(agent.runs.length, 0);
  });

  test('enrich_text passes the description to the agent', async () => {
    const h = harness();
    const agent = new FakeAgent();
    const { user, entity } = await seed(h);
    const job = await h.repo.enqueueJob({
      userId: user.id,
      job: 'enrich_text',
      entityId: entity.id,
      payload: { chatId: CHAT, channel: 'whatsapp', text: 'Padaria no centro, tel 119999' },
    });
    const worker = new Worker(h.repo, agent as unknown as EnrichmentAgent, h.flow, h.storage, h.embeddings as unknown as EmbeddingClient);
    await tick(worker);
    assert.equal(agent.runs[0]?.text, 'Padaria no centro, tel 119999');
    assert.equal((await h.repo.getJobById(job.id))?.status, 'done');
  });

  test('enrich_text without text is retried', async () => {
    const h = harness();
    const agent = new FakeAgent();
    const { user, entity } = await seed(h);
    const job = await h.repo.enqueueJob({
      userId: user.id,
      job: 'enrich_text',
      entityId: entity.id,
      payload: { chatId: CHAT, text: '   ' },
    });
    const worker = new Worker(h.repo, agent as unknown as EnrichmentAgent, h.flow, h.storage, h.embeddings as unknown as EmbeddingClient);
    await tick(worker);
    assert.match((await h.repo.getJobById(job.id))?.error ?? '', /payload\.text/);
  });

  test('embed_media stores the image vector and records its length', async () => {
    const h = harness();
    const { user, entity } = await seed(h);
    await h.storage.upload({ key: 'business/photo.png', data: Buffer.from('img'), contentType: 'image/png' });
    const png = await h.repo.createMedia({
      entityId: entity.id,
      storageUrl: 'business/photo.png',
      mimeType: 'image/png',
    });
    const job = await h.repo.enqueueJob({
      userId: user.id,
      job: 'embed_media',
      entityId: entity.id,
      entityMediaId: png.id,
      payload: { chatId: CHAT },
    });
    const mock = useFetch(async (url) => {
      assert.match(url, /signed\.example/);
      return new Response(Uint8Array.from(Buffer.from('png-bytes')), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    });
    try {
      const worker = new Worker(
        h.repo,
        new FakeAgent() as unknown as EnrichmentAgent,
        h.flow,
        h.storage,
        h.embeddings as unknown as EmbeddingClient,
      );
      await tick(worker);
    } finally {
      mock.restore();
    }
    const done = await h.repo.getJobById(job.id);
    assert.equal(done?.status, 'done');
    assert.deepEqual(done?.result, { mediaId: png.id, dims: 4 });
    const embedded = await h.repo.getMediaById(png.id);
    assert.deepEqual(embedded?.embedding, [0, 1, 0, 0]);
    assert.equal(embedded?.embeddingModel, 'test-embedding');
    assert.equal(h.embeddings.images[0]?.mimeType, 'image/png');
    assert.equal(h.embeddings.images[0]?.bytes, Buffer.from('png-bytes').length);
  });

  test('embed_media retries when the signed download fails', async () => {
    const h = harness();
    const { user, entity } = await seed(h);
    const media = await store(h, entity.id, 'business/photo.jpg');
    const job = await h.repo.enqueueJob({
      userId: user.id,
      job: 'embed_media',
      entityId: entity.id,
      entityMediaId: media.id,
      payload: {},
    });
    const mock = useFetch(async () => new Response('nope', { status: 500, statusText: 'err' }));
    try {
      const worker = new Worker(h.repo, new FakeAgent() as unknown as EnrichmentAgent, h.flow, h.storage, h.embeddings as unknown as EmbeddingClient);
      await tick(worker);
    } finally {
      mock.restore();
    }
    assert.match((await h.repo.getJobById(job.id))?.error ?? '', /500/);
  });

  test('add_contact saves people from text and announces the count', async () => {
    const h = harness();
    const agent = new FakeAgent();
    const { user, entity } = await seed(h);
    await h.repo.updateEntity(entity.id, { name: 'Oficina Norte' });
    const job = await h.repo.enqueueJob({
      userId: user.id,
      job: 'add_contact',
      entityId: entity.id,
      payload: { chatId: CHAT, channel: 'whatsapp', text: 'Ana, CEO', entityName: '' },
    });
    const worker = new Worker(h.repo, agent as unknown as EnrichmentAgent, h.flow, h.storage, h.embeddings as unknown as EmbeddingClient);
    await tick(worker);
    assert.equal(agent.contactCalls[0]?.text, 'Ana, CEO');
    const contacts = await h.repo.listContactsByEntity(entity.id);
    assert.equal(contacts[0]?.name, 'Ana');
    assert.equal(contacts[0]?.source, 'manual');
    assert.match(h.transport.lastText(), /Oficina Norte/);
    assert.equal((await h.repo.getJobById(job.id))?.status, 'done');
  });

  test('add_contact from a card photo uses the signed image and can report that nobody was found', async () => {
    const h = harness();
    const agent = new FakeAgent();
    agent.contacts = [];
    const { user, entity } = await seed(h);
    const media = await store(h, entity.id, 'cards/person.jpg');
    await h.repo.enqueueJob({
      userId: user.id,
      job: 'add_contact',
      entityId: entity.id,
      entityMediaId: media.id,
      payload: { chatId: CHAT, channel: 'whatsapp', mediaIds: [media.id], entityName: 'Oficina' },
    });
    const worker = new Worker(h.repo, agent as unknown as EnrichmentAgent, h.flow, h.storage, h.embeddings as unknown as EmbeddingClient);
    await tick(worker);
    assert.equal(agent.contactCalls[0]?.imageUrls?.length, 1);
    assert.equal(agent.contactCalls[0]?.text, undefined);
    assert.equal(h.transport.lastText(), ptBR.contactNone);
    assert.deepEqual(await h.repo.listContactsByEntity(entity.id), []);
  });

  test('skips job types it does not own and jobs that are not due yet', async () => {
    const h = harness();
    const agent = new FakeAgent();
    const { user, entity } = await seed(h);
    const media = await store(h, entity.id, 'cards/front.jpg');
    const ignored = await h.repo.enqueueJob({ userId: user.id, job: 'send_message', payload: {} });
    const later = await h.repo.enqueueJob({
      userId: user.id,
      job: 'extract_card',
      entityId: entity.id,
      entityMediaId: media.id,
      payload: { chatId: CHAT, mediaIds: [media.id] },
      scheduledAt: '2099-01-01T00:00:00.000Z',
    });
    const worker = new Worker(h.repo, agent as unknown as EnrichmentAgent, h.flow, h.storage, h.embeddings as unknown as EmbeddingClient);
    await tick(worker);
    assert.equal(agent.runs.length, 0);
    assert.equal((await h.repo.getJobById(ignored.id))?.status, 'pending');
    assert.equal((await h.repo.getJobById(later.id))?.status, 'pending');
  });

  test('a second tick does not overlap the first', async () => {
    const h = harness();
    const agent = new FakeAgent();
    const { user, entity } = await seed(h);
    const media = await store(h, entity.id, 'cards/front.jpg');
    await h.repo.enqueueJob({
      userId: user.id,
      job: 'extract_card',
      entityId: entity.id,
      entityMediaId: media.id,
      payload: { chatId: CHAT, channel: 'whatsapp', mediaIds: [media.id] },
    });
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      agent.run = async (input) => {
        agent.runs.push({
          entityId: input.entityId,
          text: input.text,
          imageUrls: [...(input.imageUrls ?? [])],
        });
        resolve();
        await new Promise<void>((resolveHold) => {
          release = resolveHold;
        });
        return { name: 'Padaria Sol', summary: 'ok' };
      };
    });
    const worker = new Worker(h.repo, agent as unknown as EnrichmentAgent, h.flow, h.storage, h.embeddings as unknown as EmbeddingClient);
    const first = tick(worker);
    await started;
    const second = tick(worker);
    release();
    await first;
    await second;
    assert.equal(agent.runs.length, 1);
  });

  test('start is idempotent and stop clears the timer', () => {
    const h = harness();
    const worker = new Worker(h.repo, new FakeAgent() as unknown as EnrichmentAgent, h.flow, h.storage, h.embeddings as unknown as EmbeddingClient, 60_000);
    try {
      worker.start();
      worker.start();
    } finally {
      worker.stop();
      worker.stop();
    }
  });

  test('a proposal aimed at a channel that is not running retries the job', async () => {
    const h = harness();
    const { user, entity } = await seed(h);
    const media = await store(h, entity.id, 'cards/front.jpg');
    const job = await h.repo.enqueueJob({
      userId: user.id,
      job: 'enrich_text',
      entityId: entity.id,
      entityMediaId: media.id,
      payload: { chatId: '42', channel: 'telegram', text: 'uma oficina' },
    });
    const worker = new Worker(h.repo, new FakeAgent() as unknown as EnrichmentAgent, h.flow, h.storage, h.embeddings as unknown as EmbeddingClient);
    await tick(worker);
    assert.match((await h.repo.getJobById(job.id))?.error ?? '', /telegram/);
  });
});
