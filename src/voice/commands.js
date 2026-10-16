import { createVoiceCommands as bindVoiceCommands } from './sessionCommands.js';
import { createProviderSession } from './voiceProvider.js';

/**
 * Default composition: OpenAI Realtime or Gemini Live, whichever the server
 * and the saved choice select. Callers may supply another adapter factory.
 */
export function createVoiceCommands(options) {
  return bindVoiceCommands({
    createSession: (hooks) => createProviderSession(hooks),
    ...options,
  });
}
