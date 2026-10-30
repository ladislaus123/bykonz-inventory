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
    '*2* — Consultar negócios 🔎\n\n' +
    'Responda com *1* ou *2*. (Você também pode enviar a foto de um cartão a qualquer momento.)',

  menuNotUnderstood:
    'Não entendi a opção. Responda com *1* para *Adicionar* ou *2* para *Consultar*.',

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
} as const;
