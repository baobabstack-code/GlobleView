const SCENE_METHODS = Object.freeze([
  'continueScene',
  'loadAdjacentShot',
  'replayShot',
  'runNextScene',
  'seekScene',
  'startScene',
  'subscribeSceneClock',
]);

/** Keep the app-facing scene service stable and load its editor/player on use. */
export function createLazySceneDirector({
  viewer,
  styleManager,
  dataManager,
  dataPacks,
  isMapStackAvailable,
  signal,
  onSceneDirector,
}) {
  let director = null;
  let pending = null;
  let destroyed = false;
  const clockSubscribers = new Set();

  const ready = () => {
    if (destroyed)
      return Promise.reject(new Error('Scene director was destroyed'));
    if (signal?.aborted)
      return Promise.reject(
        signal.reason ||
          new DOMException('Application was stopped', 'AbortError'),
      );
    if (director) return Promise.resolve(director);
    if (pending) return pending;
    pending = import('../scenes/director.js')
      .then(({ SceneDirector }) => {
        if (destroyed) throw new Error('Scene director was destroyed');
        if (signal?.aborted)
          throw (
            signal.reason ||
            new DOMException('Application was stopped', 'AbortError')
          );
        director = new SceneDirector(viewer, styleManager, dataManager, {
          dataPacks,
          isMapStackAvailable,
        });
        for (const subscriber of clockSubscribers) subscriber.attach(director);
        onSceneDirector?.(director);
        return director;
      })
      .catch((error) => {
        pending = null;
        throw error;
      });
    return pending;
  };

  const facade = {
    ready,
    listScenes: (...args) => director?.listScenes(...args) ?? [],
    findSceneByQuery: (...args) => director?.findSceneByQuery(...args) ?? null,
    getPlaybackStatus: (...args) =>
      director?.getPlaybackStatus(...args) ?? {
        running: false,
        selectedSceneId: null,
        selectedShotId: null,
        elapsedMs: null,
        estimatedDurationMs: null,
        sceneCount: 0,
      },
    stopScene: (...args) => director?.stopScene(...args) ?? false,
    get running() {
      return director?.running === true;
    },
    subscribeSceneClock(listener) {
      if (director) return director.subscribeSceneClock(listener);
      let active = true;
      let unsubscribe = null;
      const subscriber = {
        attach(instance) {
          if (active) unsubscribe = instance.subscribeSceneClock(listener);
        },
      };
      clockSubscribers.add(subscriber);
      return () => {
        active = false;
        clockSubscribers.delete(subscriber);
        unsubscribe?.();
      };
    },
    async destroy() {
      if (destroyed) return true;
      destroyed = true;
      clockSubscribers.clear();
      if (!director && !pending) return true;
      try {
        director ||= await pending;
      } catch {
        return true;
      }
      return director?.destroy?.() ?? true;
    },
  };

  for (const name of SCENE_METHODS) {
    if (Object.hasOwn(facade, name)) continue;
    facade[name] = (...args) =>
      ready().then((instance) => {
        const method = instance[name];
        return typeof method === 'function'
          ? method.apply(instance, args)
          : undefined;
      });
  }

  return new Proxy(facade, {
    get(target, property, receiver) {
      if (Reflect.has(target, property))
        return Reflect.get(target, property, receiver);
      if (!director) return undefined;
      const value = Reflect.get(director, property, director);
      return typeof value === 'function' ? value.bind(director) : value;
    },
  });
}
