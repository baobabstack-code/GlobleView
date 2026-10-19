import { initFirstRunExperience } from '../firstRunExperience.js';

/** Reveal welcome controls only after restoration and the loading transition. */
export function startApplicationChrome({
  loadingScreen,
  styleManager,
  dataManager,
  signal,
  initializeWelcome = initFirstRunExperience,
  initializeSettings,
}) {
  let disposed = false;
  let firstRun;
  let revealTimer;
  let startupCoverDismissed = false;
  let restoreSettled = false;
  const revealFirstRun = () => {
    if (
      disposed ||
      signal.aborted ||
      firstRun ||
      !startupCoverDismissed ||
      !restoreSettled
    )
      return;
    firstRun = initializeWelcome?.({ styleManager, dataManager });
    clearTimeout(revealTimer);
  };
  const onStartupCoverTransition = () => {
    startupCoverDismissed = true;
    revealFirstRun();
  };
  const hideStartupCover = () => {
    if (disposed || signal.aborted) return;
    loadingScreen.classList.add('hidden');
    loadingScreen.addEventListener('transitionend', onStartupCoverTransition, {
      once: true,
    });
    revealTimer = setTimeout(onStartupCoverTransition, 900);
  };
  void Promise.resolve(styleManager.initialRestorePromise)
    .catch(() => {
      /* Restoration reports its own outcome through the controls. */
    })
    .then(() => {
      restoreSettled = true;
      revealFirstRun();
    });
  queueMicrotask(hideStartupCover);
  const keySetup = Promise.resolve(
    signal.aborted ? null : initializeSettings?.({ signal }),
  );
  // Own the pending initializer too; it must not reveal a dialog after abort.
  void keySetup.catch(() =>
    console.error('Provider settings initialization failed'),
  );
  return async () => {
    disposed = true;
    clearTimeout(revealTimer);
    loadingScreen.removeEventListener(
      'transitionend',
      onStartupCoverTransition,
    );
    firstRun?.destroy();
    (await keySetup.catch(() => null))?.destroy();
  };
}
