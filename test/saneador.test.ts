import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanear, contarPalabras } from '../src/aplicacion/saneador.ts';

const res = { nombreUsuario: (id: string) => (id === '7' ? 'Alba' : null), nombreCanal: () => 'general' };
const casos: Array<[string, string, string | null]> = [
  ['mención a displayName sin arroba', 'hola <@7> y <@!7>', 'hola Alba y Alba'],
  ['mención desconocida', 'ey <@999>', 'ey alguien'],
  ['everyone neutralizado', 'aviso @everyone y @here', 'aviso todos y todos'],
  ['canal', 'mira <#5>', 'mira general'],
  ['bloque de código entero fuera (antes que las demás reglas)', 'antes ```js\n<@7> peligro\n``` después', 'antes después'],
  ['spoiler fuera', 'esto ||secreto|| queda', 'esto queda'],
  ['emoji custom y unicode fuera', 'jaja <:lol:123> <a:baila:9> 😂😂', 'jaja'],
  ['enlace enmascarado se queda con la etiqueta', 'mira [este vídeo](https://x.com/largo)', 'mira este vídeo'],
  ['URL suelta → enlace', 'pásate por https://example.com/a/b?c=d', 'pásate por enlace'],
  ['markdown fuera', '**fuerte** *suave* __sub__ ~~tachado~~ `código`', 'fuerte suave sub tachado código'],
  ['repeticiones colapsadas a 3', 'jaaaaaaaja holaaaaa', 'jaaaja holaaa'],
  ['vacío tras sanear → null', '😂😂😂', null],
  ['solo un bloque de código → null', '```\nnada\n```', null],
  ['multilínea: el salto de línea separa palabras, no las pega', 'hola\nmundo', 'hola mundo'],
  ['tabulador: separa palabras, no las pega', 'uno\tdos\ttres', 'uno dos tres'],
];
for (const [nombre, entrada, esperado] of casos) {
  test(nombre, () => assert.equal(sanear(entrada, res), esperado));
}

test('recorte a 500 por frontera de frase', () => {
  const texto = ('Frase de relleno que ocupa bastante. '.repeat(20)).trim(); // ~740 chars
  const r = sanear(texto, res)!;
  assert.ok(r.length <= 500);
  assert.ok(r.endsWith('.')); // corta en frontera, no a mitad de palabra
});

test('más del 20% no latino → null', () => {
  assert.equal(sanear('Привет как дела сегодня друг', res), null);
});

test('contarPalabras', () => assert.equal(contarPalabras('  dos   palabras '), 2));
