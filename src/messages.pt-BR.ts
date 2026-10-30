/** Portuguese (pt-BR) copy for the WhatsApp flow. */

export const ptBR = {
  welcome:
    'Olá! 👋 Eu sou o assistente da Bykonz.\n\n' +
    'Envie uma *foto* de um cartão de visita, folheto ou panfleto de um negócio. ' +
    'Vou analisar a imagem, buscar mais informações sobre a empresa na internet e ' +
    'te mostrar um resumo para você confirmar. 📸',

  askForPhoto:
    'Por favor, envie uma *foto* do cartão de visita ou folheto para começar. 📸',

  received:
    'Recebi sua imagem! 🔎 Estou analisando e buscando mais informações sobre esse ' +
    'negócio na internet. Isso leva alguns segundos…',

  /* ---- business-card front/back capture ---- */

  /** Shown after the FIRST card photo: the back is optional. */
  cardFrontReceived:
    'Recebi a foto do cartão! 📸 Se o cartão tiver *verso* (ou outras fotos), ' +
    'envie agora que eu considero tudo junto.\n\n' +
    'Quando terminar, toque em *Processar agora* ou mande qualquer mensagem.',

  /** Button to finish the capture and run the agent. */
  cardProcessNow: 'Processar agora ✅',

  /** Shown after each ADDITIONAL card photo. */
  cardMoreReceived: 'Foto adicional anexada. 📎 Envie mais fotos ou toque em *Processar agora*.',

  /** Shown when the capture is closed and the agent starts. */
  cardProcessing:
    'Perfeito! 🔎 Estou analisando as fotos e buscando mais informações sobre esse ' +
    'negócio na internet. Isso leva alguns segundos…',

  /** Rendered after the agent finishes; data is interpolated. */
  proposal: (e: { name: string; summary: string }) =>
    `Encontrei isto:\n\n*${e.name}*\n${e.summary}\n\nPosso salvar essas informações?`,

  accept: 'Aceitar ✅',
  reject: 'Recusar ❌',

  saved: 'Pronto! ✅ As informações foram salvas. Pode enviar outro cartão quando quiser.',
  discarded: 'Tudo bem, descartei essas informações. 🗑️ Envie outra foto quando quiser.',

  notUnderstood:
    'Não entendi. Se quiser cadastrar um negócio, envie uma *foto* do cartão ou folheto. ' +
    'Se eu te perguntei algo, responda com *1* (Aceitar) ou *2* (Recusar).',

  /* ---- menu + Adicionar / Consultar ---- */

  idleHint:
    'Envie uma *foto* de um cartão de visita para cadastrar automaticamente, ou digite *oi* ' +
    'para abrir o menu de opções. 📋',

  menu:
    'O que você deseja fazer?\n\n' +
    '*1* — Adicionar um negócio ➕\n' +
    '*2* — Consultar negócios 🔎\n' +
    '*3* — Adicionar um contato a um negócio 👤\n\n' +
    'Responda com *1*, *2* ou *3*. (Você também pode enviar a foto de um cartão — ou ' +
    'um áudio — a qualquer momento.)',

  menuNotUnderstood:
    'Não entendi a opção. Responda com *1* (Adicionar), *2* (Consultar) ou *3* (Adicionar contato).',

  addPrompt:
    'Certo! ➕ Descreva o negócio em *texto* — nome e qualquer informação relevante ' +
    '(segmento, cidade, telefone, site, etc.).\n\n' +
    'Você também pode enviar *fotos* do negócio ou do cartão. Vou organizar tudo e te ' +
    'mostrar um resumo para confirmar. ✍️📸',

  addNeedDescription:
    'Para cadastrar, me envie uma *descrição em texto* do negócio (nome e informações). ' +
    'Pode mandar fotos junto também. 📸',

  addAnalyzing:
    'Anotado! 🔎 Estou organizando e enriquecendo essas informações. Isso leva alguns segundos…',

  addMediaReceived:
    'Imagem recebida e anexada ao cadastro. 📎 Pode enviar mais fotos ou a descrição do negócio.',

  consultPrompt:
    'O que você procura? 🔎 Descreva o negócio em linguagem natural — por exemplo: ' +
    '_"uma empresa de eletrônicos em Amsterdam"_.',

  consultSearching: 'Buscando os negócios mais parecidos com o que você pediu… 🔎',

  consultNoResults:
    'Não encontrei nenhum negócio parecido com a sua busca. 😕 Tente descrever de outro jeito, ' +
    'ou cadastre novos negócios pelo menu (*oi* → *1*).',

  consultHeader: (count: number) =>
    count === 1
      ? 'Encontrei *1* negócio para você:'
      : `Encontrei *${count}* negócios para você:`,

  /** One result block (business details), rendered before its images. */
  consultResult: (e: {
    name: string;
    category?: string | null;
    description?: string | null;
    phone?: string | null;
    email?: string | null;
    website?: string | null;
    address?: string | null;
    similarity: number;
  }) => {
    const lines = [`*${e.name}*  _(${Math.round(e.similarity * 100)}% compatível)_`];
    if (e.category) lines.push(`🏷️ ${e.category}`);
    if (e.description) lines.push(`\n${e.description}`);
    const contacts: string[] = [];
    if (e.phone) contacts.push(`📞 ${e.phone}`);
    if (e.email) contacts.push(`✉️ ${e.email}`);
    if (e.website) contacts.push(`🌐 ${e.website}`);
    if (e.address) contacts.push(`📍 ${e.address}`);
    if (contacts.length) lines.push(`\n${contacts.join('\n')}`);
    return lines.join('\n');
  },

  /** Extra contacts block, shown after a Consultar result when a business has them. */
  consultContacts: (
    contacts: Array<{
      name?: string | null;
      role?: string | null;
      phone?: string | null;
      email?: string | null;
      label?: string | null;
    }>,
  ) => {
    const lines = ['👥 *Pessoas de contato:*'];
    for (const c of contacts) {
      // Lead with the person's name, then role (CEO, diretor, …).
      const who = c.name || c.role || c.label || 'Contato';
      const role = c.name && c.role ? ` — _${c.role}_` : '';
      const bits: string[] = [];
      if (c.phone) bits.push(`📞 ${c.phone}`);
      if (c.email) bits.push(`✉️ ${c.email}`);
      const detail = bits.length ? ` (${bits.join(', ')})` : '';
      lines.push(`• *${who}*${role}${detail}`);
    }
    return lines.join('\n');
  },

  /* ---- Adicionar contato ---- */

  contactFindPrompt:
    'A qual negócio você quer adicionar uma pessoa de contato? 👤 Descreva o negócio ' +
    '(nome ou segmento) que eu localizo para você.',

  contactNotFound:
    'Não encontrei um negócio parecido. 😕 Tente descrever de outro jeito, ou cadastre o ' +
    'negócio primeiro pelo menu (*oi* → *1*).',

  contactFoundAsk: (name: string) =>
    `Encontrei *${name}*. 👤 Agora me envie a pessoa de contato — *nome* e *cargo* ` +
    '(ex.: CEO, diretor, gerente, representante) e, se tiver, telefone e e-mail. ' +
    'Pode mandar em *texto*, *áudio* ou a *foto do cartão* da pessoa. (Mais de uma também.)',

  contactNeedDetails:
    'Me envie a pessoa de contato em *texto*, *áudio* ou *foto do cartão*: nome, cargo ' +
    '(ex.: CEO, gerente) e, se tiver, telefone e e-mail.',

  contactAnalyzing: 'Anotado! 🔎 Estou identificando a pessoa de contato…',

  contactNone:
    'Não consegui identificar uma pessoa de contato na sua mensagem. 😕 Tente novamente ' +
    'informando ao menos o *nome* e o *cargo*.',

  contactSaved: (count: number, name: string) =>
    count === 1
      ? `Pronto! ✅ Adicionei 1 pessoa de contato ao negócio *${name}*.`
      : `Pronto! ✅ Adicionei ${count} pessoas de contato ao negócio *${name}*.`,

  /* ---- voz (Deepgram) ---- */

  voiceUnavailable:
    'No momento não consigo processar áudios. 🙊 Por favor, escreva sua mensagem em *texto*.',

  voiceNotUnderstood:
    'Não consegui entender o áudio. 🙉 Tente gravar novamente ou escreva em *texto*.',

  /** Echo of what we transcribed, so the user can see what was understood. */
  voiceHeard: (transcript: string) => `🎤 Entendi: _"${transcript}"_`,
} as const;
