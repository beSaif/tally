import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GeminiError,
  blobToBase64,
  buildParseSystemInstruction,
  checkKey,
  matchCategory,
  normalizeOccurredAt,
  parseExpenses,
  parseResponseText,
  type GenerateContentRequest,
  type ParseContext,
} from '@app/lib/gemini';
import { downscaleToJpeg } from '@app/lib/image';
import { encodeWav } from '@app/lib/audio';

const KEY = 'AIzaSyTEST_key-0123456789abcdefghijklm';
const CFG = { apiKey: KEY, model: 'gemini-2.5-flash' };
// Local wall-clock time, so the expectations hold in any TZ the tests run in. 5 Oct 2026 is a Monday.
const NOW = new Date(2026, 9, 5, 14, 30, 45);
const CTX: ParseContext = {
  now: NOW,
  timeZone: 'Europe/Zurich',
  currency: 'CHF',
  language: 'en',
  categories: ['Groceries', 'Dining', 'Transport', 'Santé'],
};
const GENERATE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const MODEL_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash';

// Copied verbatim from docs/SPEC.md §7.4.
const SPEC_RESPONSE_SCHEMA: unknown = JSON.parse(`{"type":"object","properties":{
  "transcript":{"type":"string"},
  "entries":{"type":"array","items":{"type":"object","properties":{
    "amount":{"type":"number"},"currency":{"type":"string"},"description":{"type":"string"},
    "category":{"type":"string"},"occurred_at":{"type":"string"},
    "note":{"type":"string","nullable":true},"confidence":{"type":"number"}},
    "required":["amount","currency","description","category","occurred_at","confidence"],
    "propertyOrdering":["amount","currency","description","category","occurred_at","note","confidence"]}},
  "reply":{"type":"string","nullable":true}},
 "required":["transcript","entries"]}`);

const EXPECTED_INSTRUCTION = [
  'You turn what a person typed, said, or photographed into expense entries.',
  "Now: Monday 2026-10-05 14:30 (Europe/Zurich). Currency: CHF. The person's language: English.",
  'Categories (use exactly one of these names, or "Other"): Groceries, Dining, Transport, Santé.',
  'Rules:',
  '- Return one entry per purchase. "groceries 23.40, coffee 4 and the train 22.80" is three entries.',
  '- amount is the number the person pays, in CHF, as a decimal number. Words like "forty-two" are numbers. If they say an amount was split ("we split it", "half each"), amount is their share and note states the total.',
  '- If another currency is named, keep that currency code in "currency" and mention it in the note.',
  '- description: short, specific, Title Case for names ("Migros lunch", "TPG ticket", "Dinner, Bains des Pâquis"); no amounts, no dates.',
  '- occurred_at: ISO local "YYYY-MM-DDTHH:MM". Resolve "yesterday", "this morning", "Saturday". Default to now. Receipts: use the printed date/time if legible.',
  '- category: the best match from the list; otherwise "Other".',
  '- note: only useful extras (split, who with, half fare, items on a receipt); else null.',
  '- confidence: 0..1 for the whole entry.',
  '- transcript: the verbatim words for audio; the input text for text; "" for images.',
  "- If nothing is an expense, return entries: [] and a one-sentence reply in the person's language saying what was missing.",
].join('\n');

const ONE_ENTRY = {
  transcript: 'Coffee 4.50',
  entries: [{ amount: 4.5, currency: 'CHF', description: 'Coffee', category: 'Dining', occurred_at: '2026-10-05T14:30', note: null, confidence: 0.9 }],
  reply: null,
};

type Reply = Response | Error | (() => Response);

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function geminiText(text: string): Response {
  return jsonResponse({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });
}

function geminiJson(payload: unknown): Response {
  return geminiText(JSON.stringify(payload));
}

function apiError(status: number, message: string, reason?: string): Response {
  const details = reason ? [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com' }] : undefined;
  return jsonResponse({ error: { code: status, message, status: 'INVALID_ARGUMENT', details } }, status);
}

function mockFetch(...replies: Reply[]) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const next = replies.shift();
    if (next === undefined) throw new Error('unexpected fetch call');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

type FetchMock = ReturnType<typeof mockFetch>;

function requestOf(fetchMock: FetchMock, index = 0) {
  const args = fetchMock.mock.calls[index];
  if (!args) throw new Error(`fetch call #${index} did not happen`);
  const [input, init = {}] = args;
  return { url: String(input), init, headers: new Headers(init.headers) };
}

function bodyOf(fetchMock: FetchMock, index = 0): GenerateContentRequest {
  return JSON.parse(String(requestOf(fetchMock, index).init.body)) as GenerateContentRequest;
}

/** Independent base64 reference (byte by byte), to check the chunked encoder against. */
function refBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function failure(promise: Promise<unknown>): Promise<GeminiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof GeminiError) return err;
    throw err;
  }
  throw new Error('expected a GeminiError');
}

class FakeContext2D {
  fillStyle = '';
  imageSmoothingEnabled = false;
  imageSmoothingQuality = 'low';
  readonly ops: unknown[][] = [];
  fillRect(x: number, y: number, w: number, h: number): void {
    this.ops.push(['fillRect', this.fillStyle, x, y, w, h]);
  }
  drawImage(image: unknown, x: number, y: number, w: number, h: number): void {
    this.ops.push(['drawImage', image, x, y, w, h]);
  }
}

/** createImageBitmap + OffscreenCanvas stand-ins; convertToBlob returns `jpeg`. */
function stubImagePipeline(width: number, height: number, jpeg: Uint8Array<ArrayBuffer>) {
  const bitmap = { width, height, close: vi.fn() };
  const createImageBitmap = vi.fn(async (_image: Blob, _options?: ImageBitmapOptions) => bitmap);
  const canvases: Array<{ width: number; height: number; ctx: FakeContext2D; options: unknown }> = [];
  class FakeOffscreenCanvas {
    readonly ctx = new FakeContext2D();
    options: unknown = null;
    constructor(
      readonly width: number,
      readonly height: number,
    ) {
      canvases.push(this);
    }
    getContext(kind: string): FakeContext2D | null {
      return kind === '2d' ? this.ctx : null;
    }
    async convertToBlob(options: { type: string; quality: number }): Promise<Blob> {
      this.options = options;
      return new Blob([jpeg], { type: options.type });
    }
  }
  vi.stubGlobal('createImageBitmap', createImageBitmap);
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  return { bitmap, createImageBitmap, canvases };
}

/** AudioContext stand-in whose decodeAudioData yields the given channels. */
function stubDecoder(channels: number[][], sampleRate: number) {
  const contexts: Array<{ closed: boolean }> = [];
  class FakeAudioContext {
    state = 'running';
    closed = false;
    constructor() {
      contexts.push(this);
    }
    async decodeAudioData(_bytes: ArrayBuffer) {
      return {
        numberOfChannels: channels.length,
        sampleRate,
        length: channels[0]?.length ?? 0,
        getChannelData: (c: number) => Float32Array.from(channels[c] ?? []),
      };
    }
    async close(): Promise<void> {
      this.closed = true;
      this.state = 'closed';
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);
  return contexts;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseExpenses: request', () => {
  it('posts text with the exact §7 body, headers and signal', async () => {
    const fetchMock = mockFetch(geminiJson(ONE_ENTRY));
    const controller = new AbortController();
    await parseExpenses(CFG, { kind: 'text', text: 'Coffee 4.50 and the train 22.80' }, CTX, { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init, headers } = requestOf(fetchMock);
    expect(url).toBe(GENERATE_URL);
    expect(init.method).toBe('POST');
    expect(headers.get('x-goog-api-key')).toBe(KEY);
    expect(headers.get('content-type')).toBe('application/json');
    expect(init.signal).toBe(controller.signal);
    expect(bodyOf(fetchMock)).toEqual({
      systemInstruction: { parts: [{ text: EXPECTED_INSTRUCTION }] },
      contents: [{ role: 'user', parts: [{ text: 'Coffee 4.50 and the train 22.80' }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: SPEC_RESPONSE_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
  });

  it('fills the instruction from the context (language, currency, weekday, categories)', () => {
    const text = buildParseSystemInstruction({
      now: new Date(2026, 9, 4, 9, 5),
      timeZone: 'Europe/Paris',
      currency: 'EUR',
      language: 'fr',
      categories: ['Courses', ' Restaurants ', 'Santé'],
    });
    const lines = text.split('\n');
    expect(lines[1]).toBe("Now: Sunday 2026-10-04 09:05 (Europe/Paris). Currency: EUR. The person's language: French.");
    expect(lines[2]).toBe('Categories (use exactly one of these names, or "Other"): Courses, Restaurants, Santé.');
    expect(lines[5]).toContain('amount is the number the person pays, in EUR, as a decimal number.');
  });

  it('sends a WAV recording inline as audio/wav, with the transcription prompt', async () => {
    const wav = new Uint8Array(encodeWav(Float32Array.from([0, 0.25, -0.25, 1]), 16_000));
    const fetchMock = mockFetch(geminiJson(ONE_ENTRY));
    await parseExpenses(CFG, { kind: 'audio', blob: new Blob([wav], { type: 'audio/wav' }) }, CTX);
    expect(bodyOf(fetchMock).contents).toEqual([
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: 'audio/wav', data: refBase64(wav) } }, { text: 'Transcribe and extract the expenses.' }],
      },
    ]);
  });

  it('converts other recordings to 16 kHz mono WAV first', async () => {
    const contexts = stubDecoder([[0.5, -0.5, 0.25]], 16_000);
    const fetchMock = mockFetch(geminiJson(ONE_ENTRY));
    const webm = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])], { type: 'audio/webm;codecs=opus' });
    await parseExpenses(CFG, { kind: 'audio', blob: webm }, CTX);
    const expected = new Uint8Array(encodeWav(Float32Array.from([0.5, -0.5, 0.25]), 16_000));
    expect(bodyOf(fetchMock).contents[0]?.parts[0]).toEqual({ inlineData: { mimeType: 'audio/wav', data: refBase64(expected) } });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.closed).toBe(true);
  });

  it('sends the original recording when this environment cannot decode it (§7.3)', async () => {
    // Node has no AudioContext, so blobToWav16k fails like an old browser would.
    const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 9, 8, 7, 6]);
    const fetchMock = mockFetch(geminiJson(ONE_ENTRY));
    await parseExpenses(CFG, { kind: 'audio', blob: new Blob([bytes], { type: 'audio/webm;codecs=opus' }) }, CTX);
    expect(bodyOf(fetchMock).contents[0]?.parts).toEqual([
      { inlineData: { mimeType: 'audio/webm', data: refBase64(bytes) } },
      { text: 'Transcribe and extract the expenses.' },
    ]);
  });

  it('downscales a photo to a 1600 px JPEG at 0.85 and sends it with the receipt prompt', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0xff, 0xd9]);
    const { canvases, bitmap } = stubImagePipeline(3200, 2400, jpeg);
    const fetchMock = mockFetch(geminiJson(ONE_ENTRY));
    await parseExpenses(CFG, { kind: 'image', blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/heic' }) }, CTX);
    expect(canvases).toHaveLength(1);
    expect(canvases[0]).toMatchObject({ width: 1600, height: 1200, options: { type: 'image/jpeg', quality: 0.85 } });
    expect(bitmap.close).toHaveBeenCalled();
    expect(bodyOf(fetchMock).contents[0]?.parts).toEqual([
      { inlineData: { mimeType: 'image/jpeg', data: refBase64(jpeg) } },
      { text: 'This is a receipt. Extract the expense(s).' },
    ]);
  });

  it('does not re-encode a photo that downscaleToJpeg already prepared', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 42, 0xff, 0xd9]);
    const { createImageBitmap } = stubImagePipeline(800, 600, jpeg);
    const prepared = await downscaleToJpeg(new Blob([new Uint8Array([7])], { type: 'image/png' }), 1600, 0.85);
    const fetchMock = mockFetch(geminiJson(ONE_ENTRY));
    await parseExpenses(CFG, { kind: 'image', blob: prepared }, CTX);
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock).contents[0]?.parts[0]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: refBase64(jpeg) } });
  });

  it('sends the original photo when this environment cannot decode it', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 0xff, 0xd9]);
    const fetchMock = mockFetch(geminiJson(ONE_ENTRY));
    await parseExpenses(CFG, { kind: 'image', blob: new Blob([bytes], { type: 'image/jpeg' }) }, CTX);
    expect(bodyOf(fetchMock).contents[0]?.parts[0]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: refBase64(bytes) } });
  });

  it('accepts "models/…" names and falls back to the default model', async () => {
    const fetchMock = mockFetch(geminiJson(ONE_ENTRY), geminiJson(ONE_ENTRY));
    await parseExpenses({ apiKey: KEY, model: ' models/gemini-2.5-pro ' }, { kind: 'text', text: 'x' }, CTX);
    await parseExpenses({ apiKey: `  ${KEY}\n`, model: '' }, { kind: 'text', text: 'x' }, CTX);
    expect(requestOf(fetchMock, 0).url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent');
    expect(requestOf(fetchMock, 1).url).toBe(GENERATE_URL);
    expect(requestOf(fetchMock, 1).headers.get('x-goog-api-key')).toBe(KEY);
  });

  it.each(['', '   ', 'AIza key with spaces'])('refuses the unusable key %j without calling Google', async (apiKey) => {
    const fetchMock = mockFetch();
    const err = await failure(parseExpenses({ apiKey, model: 'gemini-2.5-flash' }, { kind: 'text', text: 'x' }, CTX));
    expect(err.code).toBe('invalid_key');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('parseExpenses: thinking retry', () => {
  it('retries once without thinkingConfig when the model refuses it', async () => {
    const fetchMock = mockFetch(
      apiError(400, 'Unable to submit request because thinking_budget is only supported when thinking is enabled.'),
      geminiJson(ONE_ENTRY),
    );
    const result = await parseExpenses(CFG, { kind: 'text', text: 'Coffee 4.50' }, CTX);
    expect(result.entries).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = bodyOf(fetchMock, 0);
    const second = bodyOf(fetchMock, 1);
    expect(first.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(second).toEqual({
      ...first,
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: SPEC_RESPONSE_SCHEMA },
    });
    expect(requestOf(fetchMock, 1).url).toBe(GENERATE_URL);
  });

  it('matches "thinking" case-insensitively (e.g. an unknown thinkingConfig field)', async () => {
    const fetchMock = mockFetch(
      apiError(400, 'Invalid JSON payload received. Unknown name "thinkingConfig" at \'generation_config\': Cannot find field.'),
      geminiJson(ONE_ENTRY),
    );
    await parseExpenses(CFG, { kind: 'text', text: 'x' }, CTX);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries only once', async () => {
    const fetchMock = mockFetch(
      apiError(400, 'Budget 0 is invalid. This model only works in thinking mode.'),
      apiError(400, 'Budget 0 is invalid. This model only works in thinking mode.'),
    );
    const err = await failure(parseExpenses(CFG, { kind: 'text', text: 'x' }, CTX));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(err).toMatchObject({ code: 'unknown', status: 400 });
  });

  it('does not retry other 400s', async () => {
    const fetchMock = mockFetch(apiError(400, 'Request contains an invalid argument.'));
    const err = await failure(parseExpenses(CFG, { kind: 'text', text: 'x' }, CTX));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toMatchObject({ code: 'unknown', status: 400, message: 'Request contains an invalid argument.' });
  });
});

describe('parseExpenses: errors', () => {
  it.each([
    {
      name: '400 API_KEY_INVALID',
      reply: () => apiError(400, 'API key not valid. Please pass a valid API key.', 'API_KEY_INVALID'),
      code: 'invalid_key',
      status: 400,
      message: 'API key not valid. Please pass a valid API key.',
    },
    {
      name: '400 mentioning the API key',
      reply: () => apiError(400, 'API key expired. Please renew the API key.'),
      code: 'invalid_key',
      status: 400,
      message: 'API key expired. Please renew the API key.',
    },
    { name: '401', reply: () => apiError(401, 'Request had invalid authentication credentials.'), code: 'invalid_key', status: 401 },
    { name: '403', reply: () => apiError(403, 'Requests from referer <empty> are blocked.'), code: 'invalid_key', status: 403 },
    {
      name: '404',
      reply: () => apiError(404, 'models/gemini-9 is not found for API version v1beta, or is not supported for generateContent.'),
      code: 'model_not_found',
      status: 404,
      message: 'models/gemini-9 is not found for API version v1beta, or is not supported for generateContent.',
    },
    { name: '429', reply: () => apiError(429, 'Resource has been exhausted (e.g. check quota).'), code: 'quota', status: 429 },
    {
      name: '500',
      reply: () => apiError(500, 'An internal error has occurred.'),
      code: 'unknown',
      status: 500,
      message: 'An internal error has occurred.',
    },
    {
      name: '503 without a JSON body',
      reply: () => new Response('<html>Service Unavailable</html>', { status: 503 }),
      code: 'unknown',
      status: 503,
      message: 'Gemini request failed (HTTP 503).',
    },
    {
      name: '404 without a body',
      reply: () => new Response(null, { status: 404 }),
      code: 'model_not_found',
      status: 404,
      message: 'Model not found: gemini-2.5-flash.',
    },
  ])('maps $name to $code', async ({ reply, code, status, message }) => {
    mockFetch(reply);
    const err = await failure(parseExpenses(CFG, { kind: 'text', text: 'Coffee 4.50' }, CTX));
    expect(err).toBeInstanceOf(GeminiError);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.message.length).toBeGreaterThan(0);
    if (message) expect(err.message).toBe(message);
    expect(err.message).not.toContain(KEY);
  });

  it('maps a fetch TypeError to network', async () => {
    mockFetch(new TypeError('Failed to fetch'));
    const err = await failure(parseExpenses(CFG, { kind: 'text', text: 'x' }, CTX));
    expect(err.code).toBe('network');
    expect(err.status).toBeUndefined();
  });

  it('maps an AbortError to aborted', async () => {
    mockFetch(new DOMException('The operation was aborted.', 'AbortError'));
    const err = await failure(parseExpenses(CFG, { kind: 'text', text: 'x' }, CTX));
    expect(err.code).toBe('aborted');
  });

  it('does not call Google when the signal is already aborted', async () => {
    const fetchMock = mockFetch();
    const controller = new AbortController();
    controller.abort();
    const err = await failure(parseExpenses(CFG, { kind: 'text', text: 'x' }, CTX, { signal: controller.signal }));
    expect(err.code).toBe('aborted');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports aborted when the signal fires mid-request', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const pending = parseExpenses(CFG, { kind: 'text', text: 'x' }, CTX, { signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    controller.abort();
    expect((await failure(pending)).code).toBe('aborted');
  });

  it('never puts the key in a message, even when the API echoes it', async () => {
    mockFetch(apiError(400, `API key not valid: ${KEY}`, 'API_KEY_INVALID'));
    const err = await failure(parseExpenses(CFG, { kind: 'text', text: 'x' }, CTX));
    expect(err.code).toBe('invalid_key');
    expect(err.message).not.toContain(KEY);
    expect(err.message).toBe('API key not valid: [key]');
  });

  it.each([
    { name: 'a body that is not JSON', reply: () => new Response('<html>captive portal</html>', { status: 200 }) },
    { name: 'no candidates (blocked prompt)', reply: () => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }), detail: 'SAFETY' },
    { name: 'a candidate without content', reply: () => jsonResponse({ candidates: [{ finishReason: 'SAFETY' }] }), detail: 'SAFETY' },
    { name: 'an empty candidate text', reply: () => geminiText('   ') },
    { name: 'text that is not JSON', reply: () => geminiText('Sure! Coffee was 4.50.') },
    { name: 'truncated JSON', reply: () => geminiText('{"transcript":"x","entries":[{"amount":4.5,') },
    { name: 'a negative amount', reply: () => geminiJson({ transcript: '', entries: [{ amount: -3 }] }), detail: 'entries.0.amount' },
    { name: 'a non-numeric amount', reply: () => geminiJson({ transcript: '', entries: [{ amount: 'abc' }] }) },
    { name: 'a missing amount', reply: () => geminiJson({ transcript: '', entries: [{ description: 'Coffee' }] }) },
    { name: 'entries that are not a list', reply: () => geminiJson({ transcript: '', entries: 'none' }) },
    { name: 'a top-level array', reply: () => geminiJson([{ amount: 3 }]) },
  ])('maps $name to bad_response', async ({ reply, detail }) => {
    mockFetch(reply);
    const err = await failure(parseExpenses(CFG, { kind: 'text', text: 'x' }, CTX));
    expect(err.code).toBe('bad_response');
    if (detail) expect(err.message).toContain(detail);
  });
});

describe('parseExpenses: response parsing', () => {
  it('reads fenced JSON split over several parts and skips thought parts', async () => {
    const json = JSON.stringify(ONE_ENTRY);
    mockFetch(
      jsonResponse({
        candidates: [
          {
            content: { parts: [{ text: 'Let me think.', thought: true }, { text: `\`\`\`json\n${json.slice(0, 25)}` }, { text: `${json.slice(25)}\n\`\`\`` }] },
            finishReason: 'STOP',
          },
        ],
      }),
    );
    const result = await parseExpenses(CFG, { kind: 'text', text: 'Coffee 4.50' }, CTX);
    expect(result).toEqual({
      transcript: 'Coffee 4.50',
      entries: [{ amount_cents: 450, currency: 'CHF', description: 'Coffee', category: 'Dining', occurred_at: '2026-10-05T14:30', note: null, confidence: 0.9 }],
      reply: null,
    });
  });

  it('accepts bare fences and prose around the JSON object', () => {
    expect(parseResponseText('```\n{"transcript":"a","entries":[]}\n```', CTX).transcript).toBe('a');
    expect(parseResponseText('Here you go: {"transcript":"b","entries":[]} Hope it helps.', CTX).transcript).toBe('b');
  });

  it('applies every normalisation rule', () => {
    const text = JSON.stringify({
      transcript: '  coffee and the rest ',
      entries: [
        { amount: 4.35, currency: 'eur', description: '  Migros   lunch ', category: ' dining ', occurred_at: '2026-10-04T12:40:59', note: '', confidence: 1.7 },
        { amount: 19.999, currency: '€', description: '', category: 'sante', occurred_at: 'yesterday', note: '  ', confidence: -0.2 },
        { amount: '12.5', currency: '', description: 'Rent', category: 'Other', occurred_at: '2026-10-04', note: ' split with Anna ', confidence: '0.8' },
        { amount: 3, currency: 'CHF', description: 'Bus', category: 'Housing', occurred_at: '2026-02-30T10:00', note: null, confidence: null },
        { amount: 7, currency: null, description: null, occurred_at: null },
      ],
      reply: '',
    });
    expect(parseResponseText(text, CTX)).toEqual({
      transcript: 'coffee and the rest',
      entries: [
        { amount_cents: 435, currency: 'EUR', description: 'Migros lunch', category: 'Dining', occurred_at: '2026-10-04T12:40', note: null, confidence: 1 },
        { amount_cents: 2000, currency: 'CHF', description: 'Expense', category: 'Santé', occurred_at: '2026-10-05T14:30', note: null, confidence: 0 },
        { amount_cents: 1250, currency: 'CHF', description: 'Rent', category: null, occurred_at: '2026-10-04T14:30', note: 'split with Anna', confidence: 0.8 },
        { amount_cents: 300, currency: 'CHF', description: 'Bus', category: null, occurred_at: '2026-10-05T14:30', note: null, confidence: 0.5 },
        { amount_cents: 700, currency: 'CHF', description: 'Expense', category: null, occurred_at: '2026-10-05T14:30', note: null, confidence: 0.5 },
      ],
      reply: null,
    });
  });

  it('uses the French fallback description', () => {
    const fr: ParseContext = { ...CTX, language: 'fr', categories: ['Courses'] };
    const result = parseResponseText(JSON.stringify({ transcript: '', entries: [{ amount: 2, description: ' ', category: 'courses' }] }), fr);
    expect(result.entries[0]).toMatchObject({ description: 'Dépense', category: 'Courses', currency: 'CHF' });
  });

  it('keeps the reply when nothing was an expense, and defaults missing fields', () => {
    expect(parseResponseText('{"transcript":"hello","entries":[],"reply":" I could not find an amount in that. "}', CTX)).toEqual({
      transcript: 'hello',
      entries: [],
      reply: 'I could not find an amount in that.',
    });
    expect(parseResponseText('{}', CTX)).toEqual({ transcript: '', entries: [], reply: null });
  });

  it('clips descriptions and notes to what the server accepts', () => {
    const result = parseResponseText(JSON.stringify({ transcript: '', entries: [{ amount: 1, description: 'x'.repeat(250), note: 'y'.repeat(600) }] }), CTX);
    expect(result.entries[0]?.description).toHaveLength(200);
    expect(result.entries[0]?.description.endsWith('…')).toBe(true);
    expect(result.entries[0]?.note).toHaveLength(500);
  });
});

describe('normalisation helpers', () => {
  it('matches categories case-, space- and accent-insensitively', () => {
    const list = ['Groceries', 'Santé', 'Dining'];
    expect(matchCategory('GROCERIES', list)).toBe('Groceries');
    expect(matchCategory(' santé ', list)).toBe('Santé');
    expect(matchCategory('Sante', list)).toBe('Santé');
    expect(matchCategory('Other', list)).toBeNull();
    expect(matchCategory('', list)).toBeNull();
    expect(matchCategory(null, list)).toBeNull();
  });

  it('normalises occurred_at', () => {
    expect(normalizeOccurredAt('2026-10-03T11:20', NOW)).toBe('2026-10-03T11:20');
    expect(normalizeOccurredAt('2026-10-03T11:20:09', NOW)).toBe('2026-10-03T11:20');
    expect(normalizeOccurredAt('2026-10-03T11:20:09.123Z', NOW)).toBe('2026-10-03T11:20');
    expect(normalizeOccurredAt('2026-10-03 11:20', NOW)).toBe('2026-10-03T11:20');
    expect(normalizeOccurredAt('2026-10-03', NOW)).toBe('2026-10-03T14:30');
    expect(normalizeOccurredAt('2026-10-03T25:00', NOW)).toBe('2026-10-05T14:30');
    expect(normalizeOccurredAt('Saturday', NOW)).toBe('2026-10-05T14:30');
    expect(normalizeOccurredAt('', NOW)).toBe('2026-10-05T14:30');
  });
});

describe('checkKey', () => {
  it('GETs the model with the key header and reports success', async () => {
    const fetchMock = mockFetch(jsonResponse({ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] }));
    await expect(checkKey(CFG)).resolves.toEqual({ ok: true, model: 'gemini-2.5-flash' });
    const { url, init, headers } = requestOf(fetchMock);
    expect(url).toBe(MODEL_URL);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(headers.get('x-goog-api-key')).toBe(KEY);
  });

  it.each([
    { name: '400', reply: () => apiError(400, 'API key not valid. Please pass a valid API key.', 'API_KEY_INVALID'), code: 'invalid_key' },
    { name: '400 without a key reason', reply: () => apiError(400, 'Request contains an invalid argument.'), code: 'invalid_key' },
    { name: '403', reply: () => apiError(403, 'Permission denied.'), code: 'invalid_key' },
    { name: '404', reply: () => apiError(404, 'models/nope is not found for API version v1beta.'), code: 'model_not_found' },
    { name: '429', reply: () => apiError(429, 'Quota exceeded.'), code: 'quota' },
    { name: '500', reply: () => apiError(500, 'Internal error.'), code: 'unknown' },
    { name: 'a fetch TypeError', reply: new TypeError('Failed to fetch'), code: 'network' },
    {
      name: 'a model that cannot generate content',
      reply: () => jsonResponse({ name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }),
      code: 'model_not_found',
    },
  ])('returns $code for $name without throwing', async ({ reply, code }) => {
    mockFetch(reply);
    const result = await checkKey(CFG);
    expect(result).toMatchObject({ ok: false, code });
    if (!result.ok) {
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.message).not.toContain(KEY);
    }
  });

  it('refuses an empty key without calling Google', async () => {
    const fetchMock = mockFetch();
    await expect(checkKey({ apiKey: ' ', model: 'gemini-2.5-flash' })).resolves.toMatchObject({ ok: false, code: 'invalid_key' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws only when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    mockFetch();
    const err = await failure(checkKey(CFG, { signal: controller.signal }));
    expect(err.code).toBe('aborted');
    mockFetch(new DOMException('The operation was aborted.', 'AbortError'));
    expect((await failure(checkKey(CFG))).code).toBe('aborted');
  });
});

describe('blobToBase64', () => {
  it('encodes small blobs', async () => {
    expect(await blobToBase64(new Blob(['Man']))).toBe('TWFu');
    expect(await blobToBase64(new Blob([]))).toBe('');
    expect(await blobToBase64(new Blob([new Uint8Array([0, 255, 128, 7])]))).toBe('AP+ABw==');
  });

  it('encodes blobs larger than one chunk exactly', async () => {
    const bytes = new Uint8Array(3 * 0x8000 + 7);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) % 256;
    expect(await blobToBase64(new Blob([bytes]))).toBe(refBase64(bytes));
  });
});
