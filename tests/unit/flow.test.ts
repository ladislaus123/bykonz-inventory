import { createHash } from 'node:crypto';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ptBR } from '../../src/messages.pt-BR.js';
import type { VoiceTranscriber } from '../../src/voice/DeepgramClient.js';
import { assistant } from '../helpers/fakes.js';
import { audioMsg, CHAT, harness, imageMsg, textMsg, type Harness } from '../helpers/harness.js';

async function userId(h: Harness): Promise<string> {
  const user = await h.repo.getUserByWaId(CHAT);
  if (!user) throw new Error('expected the flow to have created the user');
  return user.id;
}

function voice(transcript: string | (() => Promise<string>)): VoiceTranscriber {
  return {
    async transcribe() {
      return typeof transcript === 'string' ? transcript : transcript();
    },
  };
}

describe('WhatsAppFlow menu and escape hatch', { concurrency: 1 }, () => {
  test('a greeting opens the menu and "0" reopens it from any state', async () => {
    const h = harness();
    await h.flow.handle(textMsg('Oi, tudo bem?'));
    assert.equal(h.transport.lastText(), ptBR.menu);
    assert.equal(h.transport.seen.length, 1);
    const id = await userId(h);
    assert.equal((await h.repo.getConversationState(id)).state, 'menu');
    assert.ok((await h.repo.getUserById(id))?.lastSeenAt);

    await h.flow.handle(textMsg('2'));
    await h.flow.handle(textMsg('0'));
    assert.equal((await h.repo.getConversationState(id)).state, 'menu');
    assert.equal(h.transport.lastText(), ptBR.menu);
  });

  test('menu words and numbers select the right state, including the cartão/adicionar distinction', async () => {
    const cases: Array<{ text: string; state: string; snippet: string }> = [
      { text: '1', state: 'add_collecting', snippet: 'Descreva o negócio' },
      { text: 'adicionar', state: 'add_collecting', snippet: 'Descreva o negócio' },
      { text: '2', state: 'consult_await', snippet: 'O que você procura?' },
      { text: 'consultar', state: 'consult_await', snippet: 'O que você procura?' },
      { text: '3', state: 'contact_find', snippet: 'adicionar uma pessoa' },
      { text: 'contato', state: 'contact_find', snippet: 'adicionar uma pessoa' },
      { text: '4', state: 'card_await', snippet: 'foto do cartão' },
      { text: 'adicionar cartão', state: 'card_await', snippet: 'foto do cartão' },
      { text: '5', state: 'collection_await', snippet: 'nome para a coleção' },
      { text: 'coleção', state: 'collection_await', snippet: 'nome para a coleção' },
    ];
    for (const item of cases) {
      const h = harness();
      await h.flow.handle(textMsg('menu'));
      await h.flow.handle(textMsg(item.text));
      const state = await h.repo.getConversationState(await userId(h));
      assert.equal(state.state, item.state, item.text);
      assert.ok(h.transport.lastText().toLowerCase().includes(item.snippet.toLowerCase()), item.text);
    }
  });

  test('an unknown menu choice stays on the menu, and idle text asks for a photo or a greeting', async () => {
    const h = harness();
    await h.flow.handle(textMsg('toronto'));
    assert.equal(h.transport.lastText(), ptBR.idleHint);
    await h.flow.handle(textMsg('bom dia'));
    await h.flow.handle(textMsg('talvez'));
    assert.equal(h.transport.lastText(), ptBR.menuNotUnderstood);
    assert.equal((await h.repo.getConversationState(await userId(h))).state, 'menu');
  });

  test('a second message from the same sender reuses the user', async () => {
    const h = harness();
    await h.flow.handle(textMsg('oi'));
    await h.flow.handle(textMsg('oi'));
    const id = await userId(h);
    assert.equal(id, (await h.repo.getUserByWaId(CHAT))?.id);
  });
});

describe('WhatsAppFlow business card', { concurrency: 1 }, () => {
  test('the first photo parks the user in card_collecting and a later one is attached', async () => {
    const h = harness();
    await h.flow.handle(imageMsg());
    const id = await userId(h);
    const state = await h.repo.getConversationState(id);
    assert.equal(state.state, 'card_collecting');
    const mediaIds = state.context.mediaIds as string[];
    assert.equal(mediaIds.length, 1);
    const entityId = state.context.entityId as string;
    const entity = await h.repo.getEntityById(entityId);
    assert.equal(entity?.source, 'business_card');
    assert.equal(entity?.status, 'pending_review');
    assert.equal(entity?.name, 'Novo cadastro');
    const media = await h.repo.listMediaByEntity(entityId);
    assert.equal(media.length, 1);
    assert.equal(media[0]?.mimeType, 'image/jpeg');
    assert.equal(media[0]?.sha256, createHash('sha256').update(h.transport.bytes).digest('hex'));
    assert.match(media[0]?.storageUrl ?? '', new RegExp(`^cards/${id}/.+\\.jpg$`));
    assert.equal(h.storage.objects.size, 1);
    const buttons = h.transport.sentButtons.at(-1);
    assert.equal(buttons?.body, ptBR.cardFrontReceived);
    assert.equal(buttons?.buttons[0]?.id, 'card_done');

    await h.flow.handle(imageMsg());
    const more = await h.repo.getConversationState(id);
    assert.equal((more.context.mediaIds as string[]).length, 2);
    assert.equal(h.transport.sentButtons.at(-1)?.body, ptBR.cardMoreReceived);

    await h.flow.handle(textMsg('pronto'));
    assert.equal((await h.repo.getConversationState(id)).state, 'idle');
    assert.equal(h.transport.lastText(), ptBR.cardProcessing);
    const jobs = await h.repo.listJobsByUser(id);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.job, 'extract_card');
    assert.deepEqual(jobs[0]?.payload.mediaIds, more.context.mediaIds);
    assert.equal(jobs[0]?.payload.channel, 'whatsapp');
    assert.equal(jobs[0]?.entityMediaId, mediaIds[0]);
  });

  test('a greeting during capture returns to the menu without enqueueing', async () => {
    const h = harness();
    await h.flow.handle(imageMsg());
    await h.flow.handle(textMsg('oi'));
    const id = await userId(h);
    assert.equal((await h.repo.getConversationState(id)).state, 'menu');
    assert.deepEqual(await h.repo.listJobsByUser(id), []);
  });

  test('menu option 4 waits for a photo, and a photo sent from the menu starts a card', async () => {
    const h = harness();
    await h.flow.handle(textMsg('oi'));
    await h.flow.handle(textMsg('4'));
    assert.equal(h.transport.lastText(), ptBR.cardAwaitPrompt);
    await h.flow.handle(textMsg('ainda não'));
    assert.equal(h.transport.lastText(), ptBR.cardAwaitPrompt);
    await h.flow.handle(imageMsg());
    assert.equal((await h.repo.getConversationState(await userId(h))).state, 'card_collecting');
  });

  test('a photo with no downloadable bytes asks for a real photo', async () => {
    const h = harness();
    await h.flow.handle(imageMsg({ media: undefined }));
    assert.equal(h.transport.lastText(), ptBR.askForPhoto);
    assert.equal(h.storage.objects.size, 0);
  });

  test('a new photo while a proposal is pending starts a fresh capture', async () => {
    const h = harness();
    const user = await h.repo.upsertUserByWaId(CHAT, { name: CHAT, waId: CHAT });
    const pending = await h.repo.createEntity({ name: 'Antigo', status: 'pending_review', createdBy: user.id });
    await h.repo.setConversationState(user.id, 'awaiting_decision', { entityId: pending.id });
    await h.flow.handle(imageMsg());
    const state = await h.repo.getConversationState(user.id);
    assert.equal(state.state, 'card_collecting');
    assert.notEqual(state.context.entityId, pending.id);
    assert.equal((await h.repo.getEntityById(pending.id))?.status, 'pending_review');
  });
});

describe('WhatsAppFlow adicionar', { concurrency: 1 }, () => {
  test('text enqueues enrich_text and a photo enqueues embed_media on the same draft', async () => {
    const h = harness();
    await h.flow.handle(textMsg('oi'));
    await h.flow.handle(textMsg('1'));
    const id = await userId(h);
    const draft = await h.repo.getConversationState(id);
    const entityId = draft.context.entityId as string;
    assert.equal((await h.repo.getEntityById(entityId))?.source, 'manual');

    await h.flow.handle(textMsg('ok'));
    assert.equal(h.transport.lastText(), ptBR.addNeedDescription);
    assert.deepEqual(await h.repo.listJobsByUser(id), []);

    await h.flow.handle(textMsg('Padaria Sol, centro, 119999'));
    assert.equal(h.transport.lastText(), ptBR.addAnalyzing);
    await h.flow.handle(imageMsg());
    assert.equal(h.transport.lastText(), ptBR.addMediaReceived);
    const jobs = await h.repo.listJobsByUser(id);
    assert.deepEqual(jobs.map((j) => j.job), ['enrich_text', 'embed_media']);
    assert.equal(jobs[0]?.payload.text, 'Padaria Sol, centro, 119999');
    assert.equal(jobs[0]?.entityId, entityId);
    assert.equal(jobs[1]?.entityId, entityId);
    assert.equal(jobs[1]?.payload.channel, 'whatsapp');
    const media = await h.repo.listMediaByEntity(entityId);
    assert.match(media[0]?.storageUrl ?? '', /^business\//);
    assert.equal((await h.repo.getConversationState(id)).state, 'add_collecting');
  });

  test('a pdf is stored as a document', async () => {
    const h = harness();
    await h.flow.handle(textMsg('oi'));
    await h.flow.handle(textMsg('1'));
    await h.flow.handle(imageMsg({ type: 'document', media: { url: 'https://cdn.example/a.pdf', mimeType: 'application/pdf' } }));
    const id = await userId(h);
    const entityId = (await h.repo.getConversationState(id)).context.entityId as string;
    const media = await h.repo.listMediaByEntity(entityId);
    assert.equal(media[0]?.mediaType, 'document');
    assert.match(media[0]?.storageUrl ?? '', /\.pdf$/);
  });
});

describe('WhatsAppFlow consultar', { concurrency: 1 }, () => {
  async function confirmed(h: Harness, name: string, embedding: number[], extra?: { phone?: string }) {
    const id = await h.repo.upsertUserByWaId(CHAT, { name: CHAT, waId: CHAT }).then((u) => u.id);
    const entity = await h.repo.createEntity({
      name,
      description: `descrição de ${name}`,
      status: 'confirmed',
      phone: extra?.phone ?? null,
      category: 'Vestuário',
      createdBy: id,
    });
    await h.repo.setEntityEmbedding(entity.id, embedding, 'test-embedding');
    return entity;
  }

  test('reranks vector hits and sends the business, its people, and its photos', async () => {
    const h = harness();
    const kept = await confirmed(h, 'Beta Roupas', [0.96, 0.28, 0, 0], { phone: '118888' });
    await confirmed(h, 'Alfa Calçados', [1, 0, 0, 0]);
    await h.repo.createContact({ entityId: kept.id, name: 'Lia', role: 'Compradora', phone: '117777' });
    await h.storage.upload({ key: 'cards/beta.jpg', data: Buffer.from('img'), contentType: 'image/jpeg' });
    await h.repo.createMedia({ entityId: kept.id, storageUrl: 'cards/beta.jpg', mediaType: 'image', mimeType: 'image/jpeg' });
    await h.repo.createMedia({ entityId: kept.id, storageUrl: 'cards/beta.pdf', mediaType: 'document', mimeType: 'application/pdf' });
    h.embeddings.queue.push([1, 0, 0, 0]);
    h.chat.queue.push(assistant('{"1":"0","2":"2"}'));

    const id = await userId(h);
    await h.repo.setConversationState(id, 'consult_await', {});
    await h.flow.handle(textMsg('calças'));

    assert.deepEqual(h.embeddings.texts, ['calças']);
    assert.equal((await h.repo.getConversationState(id)).state, 'idle');
    const texts = h.transport.sentText.map((item) => item.text);
    assert.ok(texts.includes(ptBR.consultSearching));
    assert.ok(texts.includes(ptBR.consultHeader(1)));
    assert.ok(texts.some((text) => text.includes('Beta Roupas') && text.includes('118888')));
    assert.ok(texts.every((text) => !text.includes('Alfa Calçados')));
    assert.ok(texts.some((text) => text.includes('Lia') && text.includes('Compradora')));
    assert.equal(h.transport.sentImages.length, 1);
    assert.equal(h.transport.sentImages[0]?.image.caption, 'Beta Roupas');
    assert.match(h.transport.sentImages[0]?.image.url ?? '', /cards\/beta\.jpg/);
  });

  test('falls back to a similarity gap when the reranker returns nothing usable', async () => {
    const h = harness();
    await confirmed(h, 'Alfa', [1, 0, 0, 0]);
    await confirmed(h, 'Beta', [0.96, 0.28, 0, 0]);
    await confirmed(h, 'Oficina Distante', [0.9, Math.sqrt(0.19), 0, 0]);
    h.embeddings.queue.push([1, 0, 0, 0]);
    const id = await userId(h);
    await h.repo.setConversationState(id, 'consult_await', {});
    await h.flow.handle(textMsg('calças'));
    const blob = h.transport.sentText.map((item) => item.text).join('\n');
    assert.match(blob, /Alfa/);
    assert.match(blob, /Beta/);
    assert.doesNotMatch(blob, /Oficina Distante/);
    assert.ok(blob.includes(ptBR.consultHeader(2)));
  });

  test('says so when every candidate is unrelated, and an empty query just re-prompts', async () => {
    const h = harness();
    await confirmed(h, 'Alfa', [1, 0, 0, 0]);
    await confirmed(h, 'Beta', [0.96, 0.28, 0, 0]);
    h.embeddings.queue.push([1, 0, 0, 0]);
    h.chat.queue.push(assistant('{"1":0,"2":0}'));
    const id = await userId(h);
    await h.repo.setConversationState(id, 'consult_await', {});
    await h.flow.handle(textMsg('   '));
    assert.equal(h.transport.lastText(), ptBR.consultPrompt);
    assert.equal((await h.repo.getConversationState(id)).state, 'consult_await');

    await h.flow.handle(textMsg('pizza'));
    assert.equal(h.transport.lastText(), ptBR.consultNoResults);
    assert.equal((await h.repo.getConversationState(id)).state, 'idle');
  });

  test('a photo is not a query', async () => {
    const h = harness();
    const id = await h.repo.upsertUserByWaId(CHAT, { name: CHAT, waId: CHAT }).then((u) => u.id);
    await h.repo.setConversationState(id, 'consult_await', {});
    await h.flow.handle(imageMsg());
    assert.equal(h.transport.lastText(), ptBR.consultPrompt);
    assert.equal((await h.repo.getConversationState(id)).state, 'consult_await');
  });

  test('a broken signed URL does not hide the text result', async () => {
    const h = harness();
    const entity = await confirmed(h, 'Beta', [1, 0, 0, 0]);
    await h.repo.createMedia({ entityId: entity.id, storageUrl: 'cards/missing.jpg', mediaType: 'image' });
    h.embeddings.queue.push([1, 0, 0, 0]);
    const id = await userId(h);
    await h.repo.setConversationState(id, 'consult_await', {});
    await h.flow.handle(textMsg('roupas'));
    assert.ok(h.transport.sentText.some((item) => item.text.includes('Beta')));
    assert.equal(h.transport.sentImages.length, 0);
  });

  test('lists confirmed members when the query names a collection', async () => {
    const h = harness();
    const id = await h.repo.upsertUserByWaId(CHAT, { name: CHAT, waId: CHAT }).then((user) => user.id);
    const feira = await h.repo.upsertCollectionByName(id, 'Feira Rio');
    await h.repo.createEntity({
      name: 'Alfa Confirmed',
      description: 'mais antigo',
      status: 'confirmed',
      collectionId: feira.id,
      createdBy: id,
    });
    await h.repo.createEntity({
      name: 'Beta Newer',
      description: 'mais novo',
      status: 'confirmed',
      collectionId: feira.id,
      createdBy: id,
    });
    await h.repo.createEntity({
      name: 'Rascunho',
      description: 'ainda não',
      status: 'pending_review',
      collectionId: feira.id,
      createdBy: id,
    });
    const outra = await h.repo.upsertCollectionByName(id, 'Outra');
    await h.repo.createEntity({
      name: 'Fora',
      description: 'outra coleção',
      status: 'confirmed',
      collectionId: outra.id,
      createdBy: id,
    });
    // Newest collection is index 1. Feira Rio was created first, so it is 2.
    h.chat.queue.push(assistant('{"collection":2,"query":""}'));

    await h.repo.setConversationState(id, 'consult_await', {});
    await h.flow.handle(textMsg('feira do rio'));

    assert.deepEqual(h.embeddings.texts, []);
    assert.equal((await h.repo.getConversationState(id)).state, 'idle');
    const texts = h.transport.sentText.map((item) => item.text);
    assert.ok(texts.includes(ptBR.consultSearching));
    assert.ok(texts.includes(ptBR.consultCollectionHeader('Feira Rio', 2)));
    const blob = texts.join('\n');
    assert.ok(blob.indexOf('Beta Newer') < blob.indexOf('Alfa Confirmed'));
    assert.doesNotMatch(blob, /Rascunho/);
    assert.doesNotMatch(blob, /Fora/);
  });

  test('reranks inside a collection when the query still asks for something', async () => {
    const h = harness();
    const id = await h.repo.upsertUserByWaId(CHAT, { name: CHAT, waId: CHAT }).then((user) => user.id);
    const feira = await h.repo.upsertCollectionByName(id, 'Feira Rio');
    await h.repo.createEntity({
      name: 'Alfa Calçados',
      description: 'sapatos',
      status: 'confirmed',
      collectionId: feira.id,
      createdBy: id,
    });
    await h.repo.createEntity({
      name: 'Beta Padaria',
      description: 'pães',
      status: 'confirmed',
      collectionId: feira.id,
      createdBy: id,
    });
    // Beta is newer, so it is candidate 1. The residual keeps candidate 2.
    h.chat.queue.push(assistant('{"collection":1,"query":"calças"}'));
    h.chat.queue.push(assistant('{"1":0,"2":2}'));

    await h.repo.setConversationState(id, 'consult_await', {});
    await h.flow.handle(textMsg('calças na feira rio'));

    const blob = h.transport.sentText.map((item) => item.text).join('\n');
    assert.ok(blob.includes(ptBR.consultCollectionHeader('Feira Rio', 1)));
    assert.match(blob, /Alfa Calçados/);
    assert.doesNotMatch(blob, /Beta Padaria/);
    assert.deepEqual(h.embeddings.texts, []);
    assert.match(JSON.stringify(h.chat.calls[1]), /calças/);
  });

  test('uses semantic search when the collection pick is zero, garbage, or the call fails', async () => {
    for (const reply of ['{"collection":0,"query":"calças"}', 'não sei', null] as const) {
      const h = harness();
      await confirmed(h, 'Alfa', [1, 0, 0, 0]);
      const id = await userId(h);
      await h.repo.upsertCollectionByName(id, 'Feira Rio');
      if (reply) h.chat.queue.push(assistant(reply));
      h.embeddings.queue.push([1, 0, 0, 0]);
      await h.repo.setConversationState(id, 'consult_await', {});
      await h.flow.handle(textMsg('calças'));
      const texts = h.transport.sentText.map((item) => item.text);
      assert.ok(texts.includes(ptBR.consultHeader(1)), reply ?? 'thrown resolver');
      assert.ok(texts.some((text) => text.includes('Alfa')));
      assert.deepEqual(h.embeddings.texts, ['calças']);
    }
  });

  test('says when the named collection has no confirmed businesses', async () => {
    const h = harness();
    const id = await h.repo.upsertUserByWaId(CHAT, { name: CHAT, waId: CHAT }).then((user) => user.id);
    const feira = await h.repo.upsertCollectionByName(id, 'Feira Rio');
    await h.repo.createEntity({
      name: 'Rascunho',
      status: 'pending_review',
      collectionId: feira.id,
      createdBy: id,
    });
    h.chat.queue.push(assistant('{"collection":1,"query":""}'));
    await h.repo.setConversationState(id, 'consult_await', {});
    await h.flow.handle(textMsg('feira rio'));
    assert.equal(h.transport.lastText(), ptBR.consultCollectionEmpty('Feira Rio'));
    assert.equal((await h.repo.getConversationState(id)).state, 'idle');
  });
});

describe('WhatsAppFlow contacts and collections', { concurrency: 1 }, () => {
  test('finds a business, then enqueues a contact from text or from a card photo', async () => {
    const h = harness();
    const user = await h.repo.upsertUserByWaId(CHAT, { name: CHAT, waId: CHAT });
    const entity = await h.repo.createEntity({
      name: 'Eletrônicos Amsterdam',
      description: 'loja de eletrônicos',
      status: 'confirmed',
      createdBy: user.id,
    });
    await h.repo.setEntityEmbedding(entity.id, [1, 0, 0, 0], 'test-embedding');
    await h.flow.handle(textMsg('oi'));
    await h.flow.handle(textMsg('3'));
    h.embeddings.queue.push([0, 1, 0, 0]);
    await h.flow.handle(textMsg('padaria'));
    assert.equal(h.transport.lastText(), ptBR.contactNotFound);
    assert.equal((await h.repo.getConversationState(user.id)).state, 'contact_find');

    h.embeddings.queue.push([1, 0, 0, 0]);
    await h.flow.handle(textMsg('eletrônicos'));
    assert.match(h.transport.lastText(), /Eletrônicos Amsterdam/);
    assert.equal((await h.repo.getConversationState(user.id)).state, 'contact_await');

    await h.flow.handle(textMsg('Ana, CEO, 119999'));
    assert.equal((await h.repo.getConversationState(user.id)).state, 'idle');
    const jobs = await h.repo.listJobsByUser(user.id);
    assert.equal(jobs[0]?.job, 'add_contact');
    assert.equal(jobs[0]?.entityId, entity.id);
    assert.equal(jobs[0]?.payload.text, 'Ana, CEO, 119999');
    assert.equal(h.transport.lastText(), ptBR.contactAnalyzing);

    await h.repo.setConversationState(user.id, 'contact_await', { entityId: entity.id, entityName: entity.name });
    await h.flow.handle(imageMsg());
    const photoJob = (await h.repo.listJobsByUser(user.id)).at(-1);
    assert.equal(photoJob?.job, 'add_contact');
    assert.deepEqual(photoJob?.payload.mediaIds, [photoJob?.entityMediaId]);
    assert.equal((await h.repo.getConversationState(user.id)).state, 'idle');
  });

  test('names, shows, and clears the active collection, and stamps it on new cards', async () => {
    const h = harness();
    await h.flow.handle(textMsg('oi'));
    await h.flow.handle(textMsg('5'));
    await h.flow.handle(textMsg('   '));
    assert.equal(h.transport.lastText(), ptBR.collectionPrompt());
    await h.flow.handle(textMsg('Feira Rio'));
    const id = await userId(h);
    const collection = (await h.repo.listCollectionsByUser(id))[0];
    assert.equal(collection?.name, 'Feira Rio');
    assert.equal((await h.repo.getUserById(id))?.activeCollectionId, collection?.id);
    assert.equal((await h.repo.getConversationState(id)).state, 'idle');
    assert.match(h.transport.lastText(), /\*Feira Rio\*/);

    await h.flow.handle(textMsg('oi'));
    assert.match(h.transport.lastText(), /Feira Rio/);
    assert.ok(h.transport.lastText().includes(ptBR.menu));

    await h.flow.handle(imageMsg());
    const entityId = (await h.repo.getConversationState(id)).context.entityId as string;
    assert.equal((await h.repo.getEntityById(entityId))?.collectionId, collection?.id);

    await h.flow.handle(textMsg('oi'));
    await h.flow.handle(textMsg('5'));
    await h.flow.handle(textMsg('feira rio'));
    assert.equal((await h.repo.listCollectionsByUser(id)).length, 1);

    await h.flow.handle(textMsg('oi'));
    await h.flow.handle(textMsg('5'));
    await h.flow.handle(textMsg('nenhuma'));
    assert.equal((await h.repo.getUserById(id))?.activeCollectionId, null);
    assert.equal(h.transport.lastText(), ptBR.collectionCleared);
  });
});

describe('WhatsAppFlow decisions, voice, and failures', { concurrency: 1 }, () => {
  test('accept confirms and embeds a description that has no vector yet', async () => {
    const h = harness();
    const user = await h.repo.upsertUserByWaId(CHAT, { name: CHAT, waId: CHAT });
    const entity = await h.repo.createEntity({
      name: 'Padaria Sol',
      description: 'Padaria no centro.',
      phone: '119999',
      status: 'pending_review',
      createdBy: user.id,
    });
    await h.repo.setConversationState(user.id, 'awaiting_decision', { entityId: entity.id });
    await h.flow.handle(textMsg('aceitar'));
    const saved = await h.repo.getEntityById(entity.id);
    assert.equal(saved?.status, 'confirmed');
    assert.ok(saved?.confirmedAt);
    assert.deepEqual(saved?.descriptionEmbedding, [1, 0, 0, 0]);
    assert.deepEqual(h.embeddings.texts, ['Padaria no centro.']);
    assert.equal(h.transport.lastText(), ptBR.saved({ entityName: 'Padaria Sol' }));
    assert.equal((await h.repo.getConversationState(user.id)).state, 'menu');
  });

  test('accept skips embedding when the agent already stored one, and reject discards', async () => {
    const h = harness();
    const user = await h.repo.upsertUserByWaId(CHAT, { name: CHAT, waId: CHAT });
    const ready = await h.repo.createEntity({
      name: 'Pronta',
      description: 'já embutida',
      status: 'pending_review',
      createdBy: user.id,
    });
    await h.repo.setEntityEmbedding(ready.id, [0, 1, 0, 0], 'already');
    await h.repo.setConversationState(user.id, 'awaiting_decision', { entityId: ready.id });
    await h.flow.handle(textMsg('1'));
    assert.equal(h.embeddings.texts.length, 0);
    assert.equal((await h.repo.getEntityById(ready.id))?.embeddingModel, 'already');

    const rejected = await h.repo.createEntity({ name: 'Não', status: 'pending_review', createdBy: user.id });
    await h.repo.setConversationState(user.id, 'awaiting_decision', { entityId: rejected.id });
    await h.flow.handle(textMsg('não'));
    assert.equal((await h.repo.getEntityById(rejected.id))?.status, 'rejected');
    assert.equal(h.transport.lastText(), ptBR.discarded);
  });

  test('an unclear reply stays on the decision, and a missing entity falls back to the newest pending row', async () => {
    const h = harness();
    const user = await h.repo.upsertUserByWaId(CHAT, { name: CHAT, waId: CHAT });
    const entity = await h.repo.createEntity({ name: 'A', status: 'pending_review', createdBy: user.id });
    await h.repo.setConversationState(user.id, 'awaiting_decision', { entityId: entity.id });
    await h.flow.handle(textMsg('talvez'));
    assert.equal(h.transport.lastText(), ptBR.notUnderstood);
    assert.equal((await h.repo.getConversationState(user.id)).state, 'awaiting_decision');

    await h.repo.setConversationState(user.id, 'awaiting_decision', {});
    const older = await h.repo.createEntity({ name: 'Antiga', status: 'pending_review', createdBy: user.id });
    const newer = await h.repo.createEntity({ name: 'Nova', status: 'pending_review', createdBy: user.id });
    await h.flow.handle(textMsg('sim'));
    assert.equal((await h.repo.getEntityById(newer.id))?.status, 'confirmed');
    assert.equal((await h.repo.getEntityById(older.id))?.status, 'pending_review');
    assert.equal((await h.repo.getEntityById(entity.id))?.status, 'pending_review');
  });

  test('with no pending entity, accept explains and returns to idle', async () => {
    const h = harness();
    const user = await h.repo.upsertUserByWaId(CHAT, { name: CHAT, waId: CHAT });
    await h.repo.setConversationState(user.id, 'awaiting_decision', {});
    await h.flow.handle(textMsg('2'));
    assert.equal(h.transport.lastText(), ptBR.notUnderstood);
    assert.equal((await h.repo.getConversationState(user.id)).state, 'idle');
  });

  test('voice is transcribed and then routed like typed text', async () => {
    const h = harness({ voice: voice('oi') });
    await h.flow.handle(audioMsg());
    assert.equal(h.transport.sentText[0]?.text, ptBR.voiceHeard('oi'));
    assert.equal(h.transport.lastText(), ptBR.menu);
    assert.deepEqual(h.transport.typing.map((item) => item.on), [true, false]);
  });

  test('voice that is off, empty, or failing asks the user to type', async () => {
    const off = harness();
    await off.flow.handle(audioMsg());
    assert.equal(off.transport.lastText(), ptBR.voiceUnavailable);

    const empty = harness({ voice: voice('') });
    await empty.flow.handle(audioMsg());
    assert.equal(empty.transport.lastText(), ptBR.voiceNotUnderstood);

    const broken = harness({
      voice: voice(async () => {
        throw new Error('deepgram down');
      }),
    });
    await broken.flow.handle(audioMsg());
    assert.equal(broken.transport.lastText(), ptBR.voiceNotUnderstood);

    const noBytes = harness({ voice: voice('oi') });
    noBytes.transport.failDownload = true;
    await noBytes.flow.handle(audioMsg());
    assert.equal(noBytes.transport.lastText(), ptBR.voiceNotUnderstood);
  });

  test('a transcribed menu choice follows the menu', async () => {
    const h = harness({ voice: voice('2') });
    await h.flow.handle(textMsg('oi'));
    await h.flow.handle(audioMsg());
    assert.equal((await h.repo.getConversationState(await userId(h))).state, 'consult_await');
  });

  test('presentProposal and announceContactsSaved talk on the requested channel', async () => {
    const h = harness({ channels: ['whatsapp', 'telegram'] });
    const user = await h.repo.upsertUserByWaId(CHAT, { name: CHAT, waId: CHAT });
    const entity = await h.repo.createEntity({
      name: 'Rascunho',
      phone: '119999',
      category: 'Alimentação',
      createdBy: user.id,
    });
    await h.flow.presentProposal(user.id, '42', 'telegram', entity.id, {
      name: 'Padaria Sol',
      summary: 'Pães.',
    });
    assert.equal((await h.repo.getConversationState(user.id)).state, 'awaiting_decision');
    const buttons = h.transports.telegram?.sentButtons[0];
    assert.match(buttons?.body ?? '', /Padaria Sol/);
    assert.match(buttons?.body ?? '', /119999/);
    assert.match(buttons?.body ?? '', /Alimentação/);
    assert.deepEqual(buttons?.buttons.map((b) => b.id), ['accept', 'reject']);
    assert.equal(h.transports.whatsapp?.sentButtons.length, 0);

    await h.flow.announceContactsSaved('42', 'telegram', 2, 'Padaria Sol');
    assert.match(h.transports.telegram?.lastText() ?? '', /2 pessoas/);
    await h.flow.announceContactsSaved('42', 'telegram', 0, 'Padaria Sol');
    assert.equal(h.transports.telegram?.lastText(), ptBR.contactNone);
  });

  test('a repository failure becomes a short apology, and a send failure does not throw', async () => {
    const h = harness();
    h.repo.upsertUserByWaId = async () => {
      throw new Error('db down');
    };
    await h.flow.handle(textMsg('oi'));
    assert.equal(h.transport.lastText(), 'Ops, tive um problema ao processar sua mensagem. Tente novamente.');

    const send = harness();
    send.transport.failSend = true;
    await send.flow.handle(textMsg('oi'));
    const id = await userId(send);
    assert.equal((await send.repo.getConversationState(id)).state, 'menu');
  });

  test('Telegram replies stay on Telegram', async () => {
    const h = harness({ channels: ['whatsapp', 'telegram'] });
    await h.flow.handle(textMsg('oi', { channel: 'telegram', chatId: '42', from: '42' }));
    assert.equal(h.transports.telegram?.lastText(), ptBR.menu);
    assert.equal(h.transports.whatsapp?.sentText.length, 0);
  });
});
