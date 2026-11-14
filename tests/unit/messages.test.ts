import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ptBR } from '../../src/messages.pt-BR.js';

describe('pt-BR copy', { concurrency: 1 }, () => {
  test('menu lists every flow and the escape hatch', () => {
    for (const n of ['1', '2', '3', '4', '5']) assert.match(ptBR.menu, new RegExp(`\\*${n}\\*`));
    assert.match(ptBR.menu, /Adicionar um negócio/);
    assert.match(ptBR.menu, /Consultar/);
    assert.match(ptBR.menu, /contato/);
    assert.match(ptBR.menu, /cartão/);
    assert.match(ptBR.menu, /coleção/i);
  });

  test('proposal includes the business, its contacts, and the back hint', () => {
    const body = ptBR.proposal({
      name: 'Padaria Sol',
      summary: 'Padaria no centro.',
      category: 'Alimentação',
      phone: '119999',
      email: 'oi@sol.test',
      website: 'https://sol.test',
      address: 'Rua A, 1',
    });
    assert.match(body, /\*Padaria Sol\*/);
    assert.match(body, /Padaria no centro/);
    assert.match(body, /Alimentação/);
    assert.match(body, /Telefone: 119999/);
    assert.match(body, /E-mail: oi@sol\.test/);
    assert.match(body, /Site: https:\/\/sol\.test/);
    assert.match(body, /Endereço: Rua A, 1/);
    assert.match(body, /Digite \*0\*/);
  });

  test('consult copy pluralizes and prints similarity plus extra people', () => {
    assert.equal(ptBR.consultHeader(1), 'Encontrei *1* negócio para você:');
    assert.match(ptBR.consultHeader(2), /\*2\* negócios/);
    assert.equal(ptBR.consultCollectionHeader('Feira', 1), 'Na coleção *Feira* encontrei *1* negócio:');
    assert.match(ptBR.consultCollectionHeader('Feira', 2), /Na coleção \*Feira\* encontrei \*2\* negócios/);
    assert.match(ptBR.consultCollectionEmpty('Feira'), /coleção \*Feira\*/);
    assert.match(ptBR.consultCollectionEmpty('Feira'), /não tem negócios confirmados/);
    const block = ptBR.consultResult({
      name: 'Beta',
      category: 'Vestuário',
      description: 'Roupas',
      phone: '118888',
      similarity: 0.256,
    });
    assert.match(block, /\*Beta\*/);
    assert.match(block, /26% compatível/);
    assert.match(block, /Telefone: 118888/);
    const people = ptBR.consultContacts([
      { name: 'Ana', role: 'CEO', phone: '117777', email: 'ana@x.test' },
      { role: 'Sócio' },
    ]);
    assert.match(people, /\*Ana\* — CEO \(117777, ana@x\.test\)/);
    assert.match(people, /\*Sócio\*/);
  });

  test('voice and collection lines interpolate the user-facing values', () => {
    assert.equal(ptBR.voiceHeard('uma padaria'), 'Entendi: "uma padaria"');
    assert.match(ptBR.collectionSet('Feira Rio'), /\*Feira Rio\*/);
    assert.match(ptBR.menuActiveCollection('Feira Rio'), /\*Feira Rio\*/);
    assert.match(ptBR.contactSaved(1, 'Padaria Sol'), /1 pessoa de contato/);
    assert.match(ptBR.contactSaved(1, 'Padaria Sol'), /\*Padaria Sol\*/);
    assert.match(ptBR.contactSaved(3, 'Padaria Sol'), /3 pessoas/);
    assert.match(ptBR.contactFoundAsk('Beta'), /\*Beta\*/);
  });
});
