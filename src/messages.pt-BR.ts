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
} as const;
