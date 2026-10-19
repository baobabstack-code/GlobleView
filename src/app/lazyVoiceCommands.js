import { createVoiceControl } from '../voice/control.js';

/** Keep the mic visible while deferring the realtime and action runtimes. */
export function createLazyVoiceCommands(options) {
  const ui = createVoiceControl();
  let commands = null;
  let commandsPromise = null;
  let loading = false;
  let stopped = false;

  const attachBootstrap = () => {
    if (!stopped && !commands && !loading)
      ui.button.addEventListener('click', onFirstClick);
  };
  const detachBootstrap = () =>
    ui.button.removeEventListener('click', onFirstClick);

  const ensureCommands = () => {
    if (stopped) return Promise.resolve(null);
    if (commands) return Promise.resolve(commands);
    if (commandsPromise) return commandsPromise;
    detachBootstrap();
    commandsPromise = import('../voice/gevRealtime.js')
      .then(({ initGevVoiceCommands }) => {
        if (stopped || options.signal?.aborted) return null;
        commands = initGevVoiceCommands({
          ...options,
          // Reuse the shell created for the first-click affordance. The real
          // session handlers replace the bootstrap handler on this same node.
          createControl: () => createVoiceControl(),
        });
        return commands;
      })
      .catch((error) => {
        commandsPromise = null;
        attachBootstrap();
        ui.status.textContent = 'ERROR';
        ui.detail.textContent = 'Voice could not load. Click to retry.';
        throw error;
      });
    return commandsPromise;
  };

  async function onFirstClick() {
    if (loading || stopped) return;
    loading = true;
    ui.status.textContent = 'LOADING';
    ui.detail.textContent = 'Loading voice controls…';
    try {
      const loaded = await ensureCommands();
      if (!loaded || stopped) return;
      await loaded.session?.start?.({ pushToTalk: false });
    } catch (error) {
      console.warn('[Voice] Could not load voice controls:', error);
    } finally {
      loading = false;
      if (!commands) attachBootstrap();
    }
  }

  attachBootstrap();
  const abort = () => {
    void stop({ removeUi: true });
  };
  options.signal?.addEventListener('abort', abort, { once: true });

  const runner = async (...args) => {
    const loaded = await ensureCommands();
    if (!loaded) return { ok: false, error: 'Voice controls are unavailable' };
    return loaded.runner(...args);
  };
  runner.resetConversation = (...args) =>
    commands?.runner?.resetConversation?.(...args);
  runner.dispose = (...args) => commands?.runner?.dispose?.(...args);

  async function stop({ removeUi = false } = {}) {
    if (stopped) return true;
    stopped = true;
    detachBootstrap();
    options.signal?.removeEventListener('abort', abort);
    let stoppedCommands = false;
    if (commands) {
      await commands.stop({ removeUi });
      stoppedCommands = true;
    } else if (removeUi) ui.root.remove();
    if (commandsPromise) {
      try {
        await commandsPromise;
      } catch {
        // Startup is already unwinding; a failed optional import is settled.
      }
    }
    if (commands && !stoppedCommands) await commands.stop({ removeUi });
    if (commands && window.__gevVoiceCommands === commands)
      delete window.__gevVoiceCommands;
    return true;
  }

  return Object.freeze({
    button: ui.button,
    root: ui.root,
    runner,
    ensure: ensureCommands,
    stop,
  });
}
