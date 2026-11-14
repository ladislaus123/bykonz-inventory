import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { SupabaseRepository } from '../../src/repository/SupabaseRepository.js';
import { liveEnabled, oneHot, requireEnv } from '../helpers/live.js';

const DIM = 1536;
const live = liveEnabled();

describe('live database', { concurrency: 1, skip: live ? false : 'set RUN_LIVE_TESTS=1 (npm run test:live or npm run test:ci)' }, () => {
  let repo: SupabaseRepository | undefined;
  let admin: SupabaseClient | undefined;
  let userId: string | undefined;
  const waId = `ci-bykonz-${Date.now()}-${randomUUID()}`;

  function db(): SupabaseRepository {
    if (!repo) throw new Error('database client is not ready');
    return repo;
  }

  before(async () => {
    const url = requireEnv('SUPABASE_URL');
    const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
    const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    assert.ok(res.status !== 401 && res.status !== 403, `Supabase rejected the service role key (HTTP ${res.status})`);
    assert.ok(res.ok, `Supabase REST preflight failed: HTTP ${res.status}`);

    admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    for (const table of ['users', 'entities', 'entity_media', 'entity_contacts', 'collections', 'conversation_states', 'jobs']) {
      const probe = await admin.from(table).select('*').limit(1);
      assert.equal(probe.error, null, `${table} is not readable (${probe.error?.message}). Apply the SQL migrations in order.`);
    }

    repo = new SupabaseRepository(url, key);
    const user = await db().createUser({ name: 'CI Bykonz', contact: 'ci', waId });
    userId = user.id;
  });

  after(async () => {
    if (!userId || !admin) return;
    await admin.from('users').update({ active_collection_id: null }).eq('id', userId);
    const { error } = await admin.from('users').delete().eq('id', userId);
    if (error) throw new Error(`failed to delete CI user ${userId}: ${error.message}`);
  });

  test('upserts the WhatsApp user and records last seen', async () => {
    assert.ok(userId);
    const again = await db().upsertUserByWaId(waId, { name: 'someone else', waId });
    assert.equal(again.id, userId);
    assert.equal(again.name, 'CI Bykonz');
    assert.equal(again.locale, 'pt-BR');
    const seen = await db().updateUser(userId, { lastSeenAt: new Date().toISOString() });
    assert.ok(seen.lastSeenAt);
  });

  test('conversation state defaults to idle and round-trips', async () => {
    assert.ok(userId);
    const fresh = await db().getConversationState(userId);
    assert.equal(fresh.state, 'idle');
    await db().setConversationState(userId, 'consult_await', { chatId: 'ci' });
    const stored = await db().getConversationState(userId);
    assert.equal(stored.state, 'consult_await');
    assert.deepEqual(stored.context, { chatId: 'ci' });
    await db().setConversationState(userId, 'idle', {});
  });

  test('collections are case-insensitive per user and can be the active one', async () => {
    assert.ok(userId);
    const name = `CI Feira ${randomUUID().slice(0, 8)}`;
    const first = await db().upsertCollectionByName(userId, name);
    const second = await db().upsertCollectionByName(userId, name.toLowerCase());
    assert.equal(second.id, first.id);
    await db().updateUser(userId, { activeCollectionId: first.id });
    assert.equal((await db().getUserById(userId))?.activeCollectionId, first.id);
    assert.equal((await db().getCollectionById(first.id))?.name, name);
  });

  test('entity review, embeddings, and cosine search stay inside this user', async () => {
    assert.ok(userId);
    const collectionId = (await db().getUserById(userId))?.activeCollectionId ?? null;
    const entity = await db().createEntity({
      name: 'CI Bykonz Probe',
      description: 'registro temporário de conectividade',
      status: 'pending_review',
      source: 'manual',
      phone: '+55000000000',
      email: 'ci@bykonz.test',
      category: 'teste',
      confidence: 0.9,
      collectionId,
      createdBy: userId,
    });
    const updated = await db().updateEntity(entity.id, { website: 'https://ci.bykonz.test' });
    assert.equal(updated.website, 'https://ci.bykonz.test');
    assert.equal(updated.phone, '+55000000000');
    assert.equal(Number(updated.confidence), 0.9);

    const confirmed = await db().setEntityStatus(entity.id, 'confirmed');
    assert.equal(confirmed.status, 'confirmed');
    assert.ok(confirmed.confirmedAt);

    const vec = oneHot(DIM, 3);
    const embedded = await db().setEntityEmbedding(entity.id, vec, 'ci-test');
    assert.equal(embedded.embeddingDim, DIM);
    assert.equal(embedded.descriptionEmbedding?.length, DIM);
    assert.ok(Math.abs((embedded.descriptionEmbedding?.[3] ?? 0) - 1) < 1e-5);

    const decoy = await db().createEntity({ name: 'CI decoy', status: 'pending_review', createdBy: userId });
    await db().setEntityEmbedding(decoy.id, vec, 'ci-test');

    const matches = await db().searchEntities(vec, {
      status: 'confirmed',
      filterUser: userId,
      similarityThreshold: 0.99,
      matchCount: 5,
    });
    assert.ok(matches.some((match) => match.id === entity.id && Number(match.similarity) > 0.99));
    assert.ok(matches.every((match) => match.id !== decoy.id));

    assert.ok(collectionId);
    const inCollection = await db().listEntitiesByCollection(collectionId, { status: 'confirmed', limit: 20 });
    assert.ok(inCollection.some((row) => row.id === entity.id && row.collectionId === collectionId));
    assert.ok(inCollection.every((row) => row.status === 'confirmed'));
    const pendingInCollection = await db().listEntitiesByCollection(collectionId, { status: 'pending_review' });
    assert.ok(pendingInCollection.every((row) => row.id !== entity.id));

    const contact = await db().createContact({
      entityId: entity.id,
      name: 'CI Ana',
      role: 'QA',
      phone: '+5511',
      source: 'manual',
    });
    const contacts = await db().listContactsByEntity(entity.id);
    assert.ok(contacts.some((row) => row.id === contact.id && row.role === 'QA'));

    const media = await db().createMedia({
      entityId: entity.id,
      storageUrl: `ci-tests/${entity.id}.jpg`,
      mimeType: 'image/jpeg',
      sha256: 'ci',
    });
    const mediaVec = oneHot(DIM, 9);
    await db().setMediaEmbedding(media.id, mediaVec, 'ci-test');
    const mediaHits = await db().searchMedia(mediaVec, { filterUser: userId, similarityThreshold: 0.99 });
    assert.ok(mediaHits.some((hit) => hit.id === media.id && Number(hit.similarity) > 0.99));

    await db().deleteEntity(decoy.id);
    assert.equal(await db().getEntityById(decoy.id), null);
  });

  test('the job queue claims, retries with backoff, and completes', async () => {
    assert.ok(userId);
    const job = await db().enqueueJob({
      userId,
      job: 'send_message',
      payload: { ci: true },
      scheduledAt: '2099-01-01T00:00:00.000Z',
    });
    const visible = await db().listPendingJobs(50);
    assert.ok(!visible.some((row) => row.id === job.id));

    const running = await db().markJobRunning(job.id);
    assert.equal(running.status, 'running');
    assert.equal(running.attempts, 1);

    const retried = await db().markJobFailed(job.id, 'ci retry', { retry: true });
    assert.equal(retried.status, 'pending');
    assert.ok(retried.scheduledAt > new Date().toISOString());
    const stillHidden = await db().listPendingJobs(50);
    assert.ok(!stillHidden.some((row) => row.id === job.id));

    const dead = await db().markJobFailed(job.id, 'ci give up', { retry: false });
    assert.equal(dead.status, 'failed');
    assert.equal(dead.error, 'ci give up');

    const other = await db().enqueueJob({
      userId,
      job: 'send_message',
      payload: { ci: true },
      scheduledAt: '2099-01-01T00:00:00.000Z',
    });
    const done = await db().markJobDone(other.id, { ok: true });
    assert.equal(done.status, 'done');
    assert.deepEqual(done.result, { ok: true });
    assert.ok(done.completedAt);
  });
});
