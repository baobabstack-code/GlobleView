import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyProviderUi,
  createProviderSession,
  fetchVoiceProviders,
  readStoredVoiceProvider,
  resolveVoiceProvider,
  VOICE_PROVIDER_STORAGE_KEY,
  writeStoredVoiceProvider,
} from './voiceProvider.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    data,
  };
}

test('the stored choice is openai, gemini or auto', () => {
  const storage = memoryStorage();
  assert.equal(readStoredVoiceProvider(storage), 'auto');
  assert.equal(writeStoredVoiceProvider('gemini', storage), 'gemini');
  assert.equal(readStoredVoiceProvider(storage), 'gemini');
  assert.equal(writeStoredVoiceProvider('bogus', storage), 'auto');
  assert.equal(storage.data.has(VOICE_PROVIDER_STORAGE_KEY), false);
  assert.equal(
    readStoredVoiceProvider({
      getItem: () => {
        throw new Error('blocked');
      },
    }),
    'auto',
  );
});

test('resolution honours an explicit choice and needs a Gemini key for Gemini', () => {
  const both = { openai: true, gemini: true, default: 'openai' };
  const geminiOnly = { openai: false, gemini: true, default: 'gemini' };
  const openaiOnly = { openai: true, gemini: false, default: 'openai' };
  assert.equal(resolveVoiceProvider('auto', both), 'openai');
  assert.equal(resolveVoiceProvider('gemini', both), 'gemini');
  assert.equal(resolveVoiceProvider('auto', geminiOnly), 'gemini');
  // A ChatGPT sign-in has no API key, so an OpenAI choice holds regardless.
  assert.equal(resolveVoiceProvider('openai', geminiOnly), 'openai');
  assert.equal(resolveVoiceProvider('gemini', openaiOnly), 'openai');
});

test('a host without the roster route means OpenAI', async () => {
  const html = async () =>
    new Response('<html>', { headers: { 'content-type': 'text/html' } });
  assert.deepEqual(await fetchVoiceProviders({ fetchImpl: html }), {
    openai: true,
    gemini: false,
    default: 'openai',
  });
  const offline = async () => {
    throw new TypeError('fetch failed');
  };
  assert.equal(
    (await fetchVoiceProviders({ fetchImpl: offline })).default,
    'openai',
  );
  const live = async () =>
    Response.json({ openai: false, gemini: true, default: 'gemini' });
  assert.deepEqual(await fetchVoiceProviders({ fetchImpl: live }), {
    openai: false,
    gemini: true,
    default: 'gemini',
  });
});

/** Fake adapters that record which one ran. */
function adapters() {
  const log = [];
  const make = (name) => () => ({
    controller: name === 'openai' ? { name } : undefined,
    capabilities: {
      costControls: name === 'openai',
      pushToTalk: name === 'openai',
    },
    start: async () => log.push(`${name}.start`),
    stop: () => log.push(`${name}.stop`),
    sendText: (t) => log.push(`${name}.text:${t}`),
    sendMapEvent: () => log.push(`${name}.map`),
    bindControls: () => log.push(`${name}.bind`),
  });
  return { log, createOpenAi: make('openai'), createGemini: make('gemini') };
}

function fakeUi() {
  const button = () => ({
    hidden: false,
    textContent: '',
    attrs: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
  });
  return {
    ui: {
      button: button(),
      tierButton: button(),
      costValue: button(),
      providerButton: { ...button(), hidden: true },
      helpDetail: { textContent: '' },
    },
  };
}

test('with Gemini selected, sessions run on Gemini and OpenAI controls stay unbound', async () => {
  const { log, createOpenAi, createGemini } = adapters();
  const hooks = fakeUi();
  const session = createProviderSession(hooks, {
    createOpenAi,
    createGemini,
    fetchRoster: async () => ({
      openai: true,
      gemini: true,
      default: 'openai',
    }),
    storage: memoryStorage({ [VOICE_PROVIDER_STORAGE_KEY]: 'gemini' }),
  });
  session.bindControls();
  await session.start();
  session.sendText('hello');
  session.stop();
  assert.deepEqual(log, ['gemini.start', 'gemini.text:hello', 'gemini.stop']);
  assert.equal(hooks.ui.tierButton.hidden, true);
  assert.equal(hooks.ui.providerButton.hidden, false);
  assert.equal(hooks.ui.providerButton.textContent, 'GEMINI');
});

test('with OpenAI, its controls bind and the chip switches provider and reloads', async () => {
  const { log, createOpenAi, createGemini } = adapters();
  const hooks = fakeUi();
  const storage = memoryStorage();
  let reloaded = 0;
  const session = createProviderSession(hooks, {
    createOpenAi,
    createGemini,
    fetchRoster: async () => ({
      openai: true,
      gemini: true,
      default: 'openai',
    }),
    storage,
    reload: () => (reloaded += 1),
  });
  session.bindControls();
  await session.start();
  await session.provider;
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([...log].sort(), ['openai.bind', 'openai.start']);
  assert.equal(session.controller.name, 'openai');
  assert.equal(hooks.ui.providerButton.textContent, 'OPENAI');
  hooks.ui.providerButton.onclick();
  assert.equal(readStoredVoiceProvider(storage), 'gemini');
  assert.equal(reloaded, 1);
});

test('without a Gemini key the chip stays hidden', () => {
  const { ui } = fakeUi();
  applyProviderUi(ui, 'openai', { openai: true, gemini: false });
  assert.equal(ui.providerButton.hidden, true);
  assert.equal(ui.tierButton.hidden, false);
});
