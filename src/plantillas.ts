export const plantillas = {
  ttsActivado: (userId: string) => `<@${userId}> TTS activado babygirl`,
  ttsDesactivado: () => 'TTS desactivado. Hasta la próxima.',
  recordatorio: (userId: string) =>
    `<@${userId}> El tts sigue habilitado, babygirl. Si no quieres continuar utilizandolo recuerda ejecutar\n\`\`\`\n/jspeak disable\n\`\`\``,
  noAutorizado: () => 'No tienes el TTS habilitado en este servidor.',
  colaLlena: (limite: number) => `Cola llena (más de ${limite} palabras pendientes). Mensaje descartado; espera a que termine de sonar lo anterior.`,
  fueraDeCanal: () => 'Tienes que estar en un canal de voz para que locute tus mensajes.',
  ensordecido: () => 'Estás ensordecido: el TTS se pausa hasta que actives el audio.',
  falloTts: () => 'El sintetizador está fallando; lo reintento en unos segundos.',
  canalOcupado: (canalNombre: string) => `Ahora mismo estoy locutando en **${canalNombre}**; tu mensaje se descarta.`,
  vozFijada: (voz: string) => `Voz fijada: **${voz}**.`,
  vozNoExiste: (voz: string, parecidas: string[]) =>
    `La voz **${voz}** no existe. ¿Querías decir: ${parecidas.join(', ')}?`,
  listaVoces: (voces: { voiceId: string; description: string }[]) =>
    voces.map((v) => `**${v.voiceId}** — ${v.description}`).join('\n').slice(0, 1900),
  soloEnServidor: () => 'Este comando solo funciona dentro de un servidor.',
  sesionCaducada: (userId: string) => `<@${userId}> El TTS se ha desactivado por inactividad.`,
} as const;
