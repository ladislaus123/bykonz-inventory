import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MemoryRepository } from '../helpers/memory-repo.js';

describe('repository contract (in-memory)', { concurrency: 1 }, () => {
  test('upserts by WhatsApp id and keeps the first profile', async () => {
    const repo = new MemoryRepository();
    const created = await repo.upsertUserByWaId('5511@c.us', { name: 'Ana', waId: '5511@c.us' });
    assert.equal(created.locale, 'pt-BR');
    const again = await repo.upsertUserByWaId('5511@c.us', { name: 'Outra', waId: '5511@c.us' });
    assert.equal(again.id, created.id);
    assert.equal(again.name, 'Ana');
    const seen = await repo.updateUser(created.id, { lastSeenAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(seen.lastSeenAt, '2026-01-01T00:00:00.000Z');
  });

  test('conversation state defaults to idle and replaces context', async () => {
    const repo = new MemoryRepository();
    const user = await repo.createUser({ name: 'Ana' });
    const fresh = await repo.getConversationState(user.id);
    assert.equal(fresh.state, 'idle');
    assert.deepEqual(fresh.context, {});
    await repo.setConversationState(user.id, 'consult_await', { chatId: '1' });
    await repo.setConversationState(user.id, 'menu', {});
    const current = await repo.getConversationState(user.id);
    assert.equal(current.state, 'menu');
    assert.deepEqual(current.context, {});
  });

  test('collections are unique per user by case-insensitive name', async () => {
    const repo = new MemoryRepository();
    const user = await repo.createUser({ name: 'Ana' });
    const first = await repo.upsertCollectionByName(user.id, 'Feira Rio');
    const second = await repo.upsertCollectionByName(user.id, '  feira rio ');
    assert.equal(second.id, first.id);
    const other = await repo.upsertCollectionByName(user.id, 'Outra feira');
    assert.notEqual(other.id, first.id);
    await repo.updateUser(user.id, { activeCollectionId: first.id });
    assert.equal((await repo.getUserById(user.id))?.activeCollectionId, first.id);
    await repo.updateUser(user.id, { activeCollectionId: null });
    assert.equal((await repo.getUserById(user.id))?.activeCollectionId, null);
  });

  test('cosine search honors status, owner, and the similarity floor', async () => {
    const repo = new MemoryRepository();
    const owner = await repo.createUser({ name: 'Ana' });
    const other = await repo.createUser({ name: 'Bia' });
    const confirmed = await repo.createEntity({
      name: 'Alfa',
      description: 'calçados',
      status: 'confirmed',
      createdBy: owner.id,
    });
    const pending = await repo.createEntity({
      name: 'Beta',
      description: 'calçados também',
      status: 'pending_review',
      createdBy: owner.id,
    });
    const foreign = await repo.createEntity({
      name: 'Gama',
      description: 'igual',
      status: 'confirmed',
      createdBy: other.id,
    });
    const orthogonal = await repo.createEntity({
      name: 'Delta',
      description: 'oficina',
      status: 'confirmed',
      createdBy: owner.id,
    });
    await repo.setEntityEmbedding(confirmed.id, [1, 0, 0, 0], 'm');
    await repo.setEntityEmbedding(pending.id, [1, 0, 0, 0], 'm');
    await repo.setEntityEmbedding(foreign.id, [1, 0, 0, 0], 'm');
    await repo.setEntityEmbedding(orthogonal.id, [0, 1, 0, 0], 'm');

    const hits = await repo.searchEntities([1, 0, 0, 0], {
      status: 'confirmed',
      filterUser: owner.id,
      similarityThreshold: 0.25,
    });
    assert.deepEqual(hits.map((h) => h.id), [confirmed.id]);
    assert.ok((hits[0]?.similarity ?? 0) > 0.99);
  });

  test('finds businesses by a contact person name, confirmed-only, exact ranked first', async () => {
    const repo = new MemoryRepository();
    const owner = await repo.createUser({ name: 'Ana' });
    const shop = await repo.createEntity({
      name: 'Shopping Marítimo',
      description: 'produtos náuticos', // name is NOT in the description
      status: 'confirmed',
      createdBy: owner.id,
    });
    const other = await repo.createEntity({
      name: 'Outra Loja',
      description: 'variados',
      status: 'confirmed',
      createdBy: owner.id,
    });
    const draft = await repo.createEntity({
      name: 'Rascunho',
      description: 'pendente',
      status: 'pending_review',
      createdBy: owner.id,
    });
    await repo.createContact({ entityId: shop.id, name: 'Humberto Greco', role: 'CEO' });
    await repo.createContact({ entityId: other.id, name: 'Greco Souza', role: 'Vendedor' });
    await repo.createContact({ entityId: draft.id, name: 'Humberto Greco', role: 'CEO' });

    // Exact match ranks ahead of the substring match; the pending entity is excluded.
    const hits = await repo.findEntitiesByContactName('humberto greco', { status: 'confirmed' });
    assert.deepEqual(hits.map((h) => h.id), [shop.id]);
    assert.equal(hits[0]?.similarity, 1);

    const partial = await repo.findEntitiesByContactName('greco', { status: 'confirmed' });
    assert.deepEqual(new Set(partial.map((h) => h.id)), new Set([shop.id, other.id]));
    assert.ok(partial.every((h) => h.similarity === 0.9));

    assert.deepEqual(await repo.findEntitiesByContactName('x'), []); // too short
  });

  test('lists a collection newest first and can filter by status', async () => {
    const repo = new MemoryRepository();
    const user = await repo.createUser({ name: 'Ana' });
    const collection = await repo.createCollection({ name: 'Feira', createdBy: user.id });
    const other = await repo.createCollection({ name: 'Outra', createdBy: user.id });
    const older = await repo.createEntity({
      name: 'Antiga',
      status: 'confirmed',
      collectionId: collection.id,
      createdBy: user.id,
    });
    const newer = await repo.createEntity({
      name: 'Nova',
      status: 'confirmed',
      collectionId: collection.id,
      createdBy: user.id,
    });
    const pending = await repo.createEntity({
      name: 'Rascunho',
      status: 'pending_review',
      collectionId: collection.id,
      createdBy: user.id,
    });
    await repo.createEntity({
      name: 'Fora',
      status: 'confirmed',
      collectionId: other.id,
      createdBy: user.id,
    });

    const confirmed = await repo.listEntitiesByCollection(collection.id, { status: 'confirmed' });
    assert.deepEqual(
      confirmed.map((entity) => entity.id),
      [newer.id, older.id],
    );
    const newest = await repo.listEntitiesByCollection(collection.id, { limit: 1 });
    assert.deepEqual(
      newest.map((entity) => entity.id),
      [pending.id],
    );
    assert.equal((await repo.listEntitiesByCollection(other.id)).length, 1);
  });

  test('jobs are claimable only when pending and due, and retry with backoff', async () => {
    const repo = new MemoryRepository();
    const user = await repo.createUser({ name: 'Ana' });
    const future = await repo.enqueueJob({
      userId: user.id,
      job: 'send_message',
      scheduledAt: '2099-01-01T00:00:00.000Z',
    });
    const due = await repo.enqueueJob({ userId: user.id, job: 'extract_card' });
    const claimable = await repo.listPendingJobs();
    assert.deepEqual(claimable.map((j) => j.id), [due.id]);

    const running = await repo.markJobRunning(due.id);
    assert.equal(running.status, 'running');
    assert.equal(running.attempts, 1);
    assert.deepEqual(await repo.listPendingJobs(), []);

    const retried = await repo.markJobFailed(due.id, 'boom', { retry: true });
    assert.equal(retried.status, 'pending');
    assert.equal(retried.error, 'boom');
    assert.ok(retried.scheduledAt > new Date().toISOString());
    assert.deepEqual(await repo.listPendingJobs(), []);

    const dead = await repo.markJobFailed(due.id, 'gave up', { retry: false });
    assert.equal(dead.status, 'failed');

    const done = await repo.markJobDone(future.id, { ok: true });
    assert.equal(done.status, 'done');
    assert.deepEqual(done.result, { ok: true });
    assert.ok(done.completedAt);
  });

  test('deleting an entity removes its media and contacts and detaches jobs', async () => {
    const repo = new MemoryRepository();
    const user = await repo.createUser({ name: 'Ana' });
    const entity = await repo.createEntity({ name: 'Alfa', createdBy: user.id });
    const media = await repo.createMedia({ entityId: entity.id, storageUrl: 'cards/a.jpg' });
    await repo.createContact({ entityId: entity.id, name: 'Ana', role: 'CEO' });
    const job = await repo.enqueueJob({ userId: user.id, job: 'embed_media', entityId: entity.id, entityMediaId: media.id });
    await repo.deleteEntity(entity.id);
    assert.equal(await repo.getEntityById(entity.id), null);
    assert.equal(await repo.getMediaById(media.id), null);
    assert.deepEqual(await repo.listContactsByEntity(entity.id), []);
    assert.equal((await repo.getJobById(job.id))?.entityId, null);
  });

  test('confirming an entity stamps confirmedAt and a partial update keeps the other fields', async () => {
    const repo = new MemoryRepository();
    const user = await repo.createUser({ name: 'Ana' });
    const entity = await repo.createEntity({
      name: 'Alfa',
      phone: '119999',
      description: 'loja',
      createdBy: user.id,
    });
    const updated = await repo.updateEntity(entity.id, { website: 'https://alfa.test' });
    assert.equal(updated.phone, '119999');
    assert.equal(updated.website, 'https://alfa.test');
    const confirmed = await repo.setEntityStatus(entity.id, 'confirmed');
    assert.equal(confirmed.status, 'confirmed');
    assert.ok(confirmed.confirmedAt);
  });
});
