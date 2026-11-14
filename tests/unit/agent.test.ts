import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { EnrichmentAgent } from '../../src/agent/EnrichmentAgent.js';
import type { OpenRouterChat, ChatMessage, ToolCall } from '../../src/agent/OpenRouterChat.js';
import type { EmbeddingClient } from '../../src/embeddings/EmbeddingClient.js';
import { FakeEmbeddings, ScriptedChat } from '../helpers/fakes.js';
import { MemoryRepository } from '../helpers/memory-repo.js';

const agentCfg = {
  model: 'test-model',
  searchModel: 'test-search',
  maxSteps: 6,
  webMaxResults: 3,
};

function toolMessage(calls: Array<{ id: string; name: string; args: unknown }>): ChatMessage {
  const tool_calls: ToolCall[] = calls.map((call) => ({
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  }));
  return { role: 'assistant', content: null, tool_calls };
}

async function setup() {
  const repo = new MemoryRepository();
  const chat = new ScriptedChat();
  const embeddings = new FakeEmbeddings();
  const user = await repo.createUser({ name: 'Ana', waId: '5511@c.us' });
  const entity = await repo.createEntity({
    name: 'Novo cadastro',
    status: 'pending_review',
    createdBy: user.id,
  });
  const agent = new EnrichmentAgent(
    chat as unknown as OpenRouterChat,
    repo,
    embeddings as unknown as EmbeddingClient,
    agentCfg,
  );
  return { repo, chat, embeddings, user, entity, agent };
}

describe('EnrichmentAgent', { concurrency: 1 }, () => {
  test('searches, saves the business and its people, embeds, and finishes', async () => {
    const { repo, chat, embeddings, entity, agent } = await setup();
    chat.queue.push(
      toolMessage([{ id: 'call-search', name: 'search_web', args: { query: 'Padaria Sol São Paulo' } }]),
    );
    chat.queue.push({ role: 'assistant', content: 'Site oficial: https://padariasol.example' });
    chat.queue.push(
      toolMessage([
        {
          id: 'call-save',
          name: 'save_business',
          args: {
            name: 'Padaria Sol',
            description: 'Padaria artesanal no centro de São Paulo.',
            category: 'Alimentação',
            phone: '+5511999990000',
            email: 'oi@sol.test',
            website: 'https://padariasol.example',
            confidence: 0.8,
            contacts: [
              { name: 'Ana', role: 'CEO', email: 'ana@sol.test' },
              { phone: '+5511999990000', email: 'oi@sol.test' },
            ],
          },
        },
        {
          id: 'call-finish',
          name: 'finish',
          args: { name: 'Padaria Sol', summary: 'Padaria no centro.' },
        },
      ]),
    );

    const result = await agent.run({
      entityId: entity.id,
      imageUrls: ['https://signed.example/front.jpg', 'https://signed.example/back.jpg'],
    });

    assert.deepEqual(result, { name: 'Padaria Sol', summary: 'Padaria no centro.' });
    const saved = await repo.getEntityById(entity.id);
    assert.equal(saved?.name, 'Padaria Sol');
    assert.equal(saved?.category, 'Alimentação');
    assert.equal(saved?.phone, '+5511999990000');
    assert.equal(saved?.website, 'https://padariasol.example');
    assert.equal(saved?.status, 'pending_review');
    assert.equal(saved?.descriptionEmbedding?.length, 4);
    assert.deepEqual(embeddings.texts, ['Padaria artesanal no centro de São Paulo.']);

    const contacts = await repo.listContactsByEntity(entity.id);
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0]?.name, 'Ana');
    assert.equal(contacts[0]?.role, 'CEO');
    assert.equal(contacts[0]?.source, 'business_card');

    const firstUser = chat.calls[0]?.messages[1]?.content;
    assert.ok(Array.isArray(firstUser));
    const imageParts = firstUser.filter((part) => part.type === 'image_url');
    assert.equal(imageParts.length, 2);
    const search = chat.calls[1];
    assert.equal(search?.model, 'test-search');
    assert.equal((search?.plugins?.[0] as { id: string }).id, 'web');
    assert.equal((search?.plugins?.[0] as { max_results: number }).max_results, 3);
  });

  test('requires an image or some text', async () => {
    const { agent, entity } = await setup();
    await assert.rejects(() => agent.run({ entityId: entity.id }), /imageUrl or text/);
  });

  test('throws when the draft entity disappeared', async () => {
    const { agent, chat } = await setup();
    chat.queue.push({ role: 'assistant', content: 'ok' });
    await assert.rejects(() => agent.run({ entityId: 'missing', text: 'uma padaria' }), /vanished/);
  });

  test('returns the draft name when the model never calls finish', async () => {
    const { agent, chat, embeddings, entity } = await setup();
    chat.queue.push({ role: 'assistant', content: 'sem ferramentas' });
    const result = await agent.run({ entityId: entity.id, text: 'uma padaria' });
    assert.equal(result.name, 'Novo cadastro');
    assert.match(result.summary, /Não consegui extrair/);
    assert.equal(embeddings.texts.length, 0);
  });

  test('stops after maxSteps even if the model keeps searching', async () => {
    const { repo, chat, embeddings, entity } = await setup();
    const agent = new EnrichmentAgent(
      chat as unknown as OpenRouterChat,
      repo,
      embeddings as unknown as EmbeddingClient,
      { ...agentCfg, maxSteps: 1 },
    );
    chat.queue.push(toolMessage([{ id: 's', name: 'search_web', args: { query: 'padaria' } }]));
    chat.queue.push({ role: 'assistant', content: 'nada relevante' });
    const result = await agent.run({ entityId: entity.id, text: 'padaria' });
    assert.equal(result.name, 'Novo cadastro');
    assert.equal(chat.calls.length, 2);
  });

  test('a contact-row failure does not roll back the saved business', async () => {
    const { repo, chat, entity, agent } = await setup();
    repo.createContact = async () => {
      throw new Error('contact down');
    };
    chat.queue.push(
      toolMessage([
        {
          id: 'save',
          name: 'save_business',
          args: {
            name: 'Padaria Sol',
            description: 'Pães.',
            contacts: [{ name: 'Ana', role: 'CEO' }],
          },
        },
        { id: 'fin', name: 'finish', args: { name: 'Padaria Sol', summary: 'Pães.' } },
      ]),
    );
    const result = await agent.run({ entityId: entity.id, text: 'Padaria Sol, pães' });
    assert.equal(result.name, 'Padaria Sol');
    assert.equal((await repo.getEntityById(entity.id))?.description, 'Pães.');
  });

  test('does not re-embed a description that already has a vector', async () => {
    const { repo, chat, embeddings, entity, agent } = await setup();
    await repo.setEntityEmbedding(entity.id, [1, 0, 0, 0], 'already');
    chat.queue.push(
      toolMessage([
        {
          id: 'save',
          name: 'save_business',
          args: { name: 'Padaria Sol', description: 'Pães.' },
        },
        { id: 'fin', name: 'finish', args: { name: 'Padaria Sol', summary: 'Pães.' } },
      ]),
    );
    await agent.run({ entityId: entity.id, text: 'padaria' });
    assert.equal(embeddings.texts.length, 0);
    assert.equal((await repo.getEntityById(entity.id))?.embeddingModel, 'already');
  });

  test('extractContacts parses a fenced JSON array and ignores empty input', async () => {
    const { chat, agent } = await setup();
    assert.deepEqual(await agent.extractContacts({}), []);
    assert.equal(chat.calls.length, 0);

    chat.queue.push({
      role: 'assistant',
      content: '```json\n[{"name":"Lia","role":"COO","phone":"119888"},{}]\n```',
    });
    const contacts = await agent.extractContacts({ text: 'Lia, COO, 119888' });
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0]?.name, 'Lia');
    assert.equal(contacts[0]?.role, 'COO');
    assert.equal(contacts[0]?.phone, '119888');

    chat.queue.push({ role: 'assistant', content: 'não encontrei ninguém' });
    assert.deepEqual(await agent.extractContacts({ text: 'oi' }), []);

    chat.queue.push({ role: 'assistant', content: '[{"name":"Rui","role":"Vendedor"}]' });
    const fromCard = await agent.extractContacts({ imageUrls: ['https://signed.example/card.jpg'] });
    assert.equal(fromCard[0]?.name, 'Rui');
    const lastUser = chat.calls.at(-1)?.messages[1]?.content;
    assert.ok(Array.isArray(lastUser));
    assert.ok(lastUser.some((part) => part.type === 'image_url'));
  });
});
