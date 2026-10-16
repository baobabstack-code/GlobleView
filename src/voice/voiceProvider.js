/**
 * Which cloud voice provider a session uses (OpenAI Realtime or Gemini Live),
 * and the session adapter that switches between them.
 */
import { createGeminiSession } from './geminiSession.js';
import { createRealtimeSession } from './realtimeSession.js';

export const VOICE_PROVIDERS = Object.freeze(['openai', 'gemini']);
export const VOICE_PROVIDER_STORAGE_KEY = 'godsEyeView.voice.provider';
export const VOICE_PROVIDERS_ENDPOINT = '/api/voice/providers';

function storageRef(storage) {
  if (storage) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The saved choice: 'openai', 'gemini', or 'auto' when nothing was chosen. */
export function readStoredVoiceProvider(storage) {
  try {
    const value = String(
      storageRef(storage)?.getItem(VOICE_PROVIDER_STORAGE_KEY) || '',
    )
      .trim()
      .toLowerCase();
    return VOICE_PROVIDERS.includes(value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}

export function writeStoredVoiceProvider(provider, storage) {
  const value = VOICE_PROVIDERS.includes(provider) ? provider : 'auto';
  try {
    if (value === 'auto')
      storageRef(storage)?.removeItem(VOICE_PROVIDER_STORAGE_KEY);
    else storageRef(storage)?.setItem(VOICE_PROVIDER_STORAGE_KEY, value);
  } catch {
    /* best effort */
  }
  return value;
}

/**
 * The provider to use. An explicit OpenAI choice always holds (a ChatGPT
 * sign-in needs no API key, so the roster can't see it); Gemini needs its key.
 */
export function resolveVoiceProvider(preference, roster) {
  if (preference === 'openai') return 'openai';
  if (preference === 'gemini' && roster?.gemini) return 'gemini';
  return roster?.default === 'gemini' && roster?.gemini ? 'gemini' : 'openai';
}

/** The server's provider roster; a static host without it means OpenAI. */
export async function fetchVoiceProviders({
  fetchImpl = (...args) => fetch(...args),
  endpoint = VOICE_PROVIDERS_ENDPOINT,
} = {}) {
  try {
    const response = await fetchImpl(endpoint, { cache: 'no-store' });
    const type = response.headers.get('content-type') || '';
    if (!response.ok || !type.includes('application/json')) throw new Error();
    const data = await response.json();
    return {
      openai: Boolean(data.openai),
      gemini: Boolean(data.gemini),
      default: data.default,
    };
  } catch {
    return { openai: true, gemini: false, default: 'openai' };
  }
}

/** Show the provider chip, and the OpenAI-only cost controls only for OpenAI. */
export function applyProviderUi(ui, provider, roster, { onSwitch } = {}) {
  if (!ui) return;
  const gemini = provider === 'gemini';
  if (gemini) {
    if (ui.tierButton) ui.tierButton.hidden = true;
    if (ui.costValue) ui.costValue.hidden = true;
    if (ui.helpDetail) ui.helpDetail.textContent = 'Activate to toggle voice';
    ui.button?.setAttribute('aria-label', 'Toggle voice control (Gemini)');
  }
  const chip = ui.providerButton;
  if (!chip) return;
  chip.textContent = gemini ? 'GEMINI' : 'OPENAI';
  chip.hidden = !roster?.gemini;
  chip.title = `Voice provider: ${gemini ? 'Google Gemini' : 'OpenAI'}. Click to switch (reloads the page).`;
  chip.onclick = () => onSwitch?.(gemini ? 'openai' : 'gemini');
}

/**
 * A voice adapter that runs OpenAI or Gemini. The provider is settled once
 * per page: switching saves the choice and reloads, so OpenAI-only bindings
 * (Space push-to-talk, the tier button) never outlive their provider.
 */
export function createProviderSession(
  hooks,
  {
    createOpenAi = createRealtimeSession,
    createGemini = createGeminiSession,
    fetchRoster = fetchVoiceProviders,
    storage,
    reload = () => globalThis.location?.reload(),
  } = {},
) {
  const openai = createOpenAi(hooks);
  let gemini = null;
  const roster = fetchRoster();
  const choice = roster.then((r) =>
    resolveVoiceProvider(readStoredVoiceProvider(storage), r),
  );
  let active = openai;
  const adapterFor = (provider) =>
    provider === 'gemini' ? (gemini ||= createGemini(hooks)) : openai;

  return {
    controller: openai.controller,
    capabilities: openai.capabilities,
    provider: choice,
    async start(settings) {
      active = adapterFor(await choice);
      return active.start(settings);
    },
    stop: (settings) => active.stop(settings),
    sendText: (text) => active.sendText(text),
    sendMapEvent: (event) => active.sendMapEvent(event),
    ignoreButtonClick: () =>
      active === openai ? Boolean(openai.ignoreButtonClick?.()) : false,
    bindControls() {
      void Promise.all([choice, roster]).then(([provider, r]) => {
        applyProviderUi(hooks.ui, provider, r, {
          onSwitch: (next) => {
            writeStoredVoiceProvider(next, storage);
            reload();
          },
        });
        if (provider === 'openai') openai.bindControls?.();
      });
    },
  };
}
