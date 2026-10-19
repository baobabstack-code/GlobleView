/** Private bridge used by catalog factories that share another lazy layer. */
export const ENSURE_LAZY_LAYER = Symbol('ensure-lazy-layer');

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, clone(nested)]),
    );
  return value;
}

function merge(target, patch) {
  const result = target && typeof target === 'object' ? clone(target) : {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    return result;
  for (const [key, value] of Object.entries(patch)) {
    result[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? merge(result[key], value)
        : clone(value);
  }
  return result;
}

function call(instance, name, args, fallback) {
  const method = instance?.[name];
  return typeof method === 'function' ? method.apply(instance, args) : fallback;
}

/**
 * A synchronous layer identity whose implementation is imported on first use.
 * Lifecycle methods are async already. Metadata, options, and attachment hooks
 * remain available before the implementation is loaded.
 */
export function createLazyLayer({
  metadata,
  load,
  fallbacks = {},
  supportsRowControls = false,
}) {
  if (!metadata?.id || typeof load !== 'function')
    throw new TypeError('Lazy layers require an id and loader');

  let instance = null;
  let pending = null;
  let pendingParams = null;
  let pendingParamsOptions = null;
  let destroyed = false;
  const deferredAttachments = [];

  const hydrate = (module) => {
    if (!module || module.id !== metadata.id)
      throw new Error(
        `Lazy layer loader returned the wrong module: ${metadata.id}`,
      );
    for (const [name, args] of deferredAttachments) call(module, name, args);
    if (pendingParams) {
      if (typeof module.setParams !== 'function')
        throw new Error(
          `Lazy layer does not accept parameters: ${metadata.id}`,
        );
      if (
        module.setParams(clone(pendingParams), pendingParamsOptions) === false
      )
        throw new Error(
          `Lazy layer rejected queued parameters: ${metadata.id}`,
        );
      pendingParams = null;
      pendingParamsOptions = null;
    }
    deferredAttachments.length = 0;
    instance = module;
    return module;
  };

  const ensure = () => {
    if (destroyed)
      return Promise.reject(
        new Error(`Lazy layer was destroyed: ${metadata.id}`),
      );
    if (instance) return Promise.resolve(instance);
    if (pending) return pending;
    pending = Promise.resolve()
      .then(load)
      .then(hydrate)
      .catch((error) => {
        pending = null;
        instance = null;
        throw error;
      });
    return pending;
  };

  const target = {
    ...metadata,
    init: async (viewer, options) => {
      const module = await ensure();
      if (options?.signal?.aborted) throw options.signal.reason;
      return call(module, 'init', [viewer, options], true);
    },
    enable: async (viewer, options) => {
      const module = await ensure();
      if (options?.signal?.aborted) throw options.signal.reason;
      return call(module, 'enable', [viewer, options], true);
    },
    update: async (viewer, options) => {
      const module = await ensure();
      if (options?.signal?.aborted) throw options.signal.reason;
      return call(module, 'update', [viewer, options], true);
    },
    disable: async (viewer, options) => {
      if (!instance && !pending) return true;
      const module = await (pending || Promise.resolve(instance));
      return call(module, 'disable', [viewer, options], true);
    },
    destroy: async (...args) => {
      destroyed = true;
      if (!instance && !pending) return true;
      let module;
      try {
        module = await (pending || Promise.resolve(instance));
      } catch {
        return true;
      }
      return call(module, 'destroy', args, true);
    },
    setParams: (params, options) => {
      if (instance)
        return call(instance, 'setParams', [params, options], false);
      if (!params || typeof params !== 'object' || Array.isArray(params))
        return false;
      if (Object.keys(params).length === 0) return true;
      pendingParams = merge(pendingParams, params);
      pendingParamsOptions = options ? { ...options } : null;
      return true;
    },
    getParams: () => {
      if (instance) {
        const value = call(instance, 'getParams', [], null);
        if (value && typeof value === 'object') return clone(value);
      }
      return clone(pendingParams || {});
    },
    getStats: () =>
      call(instance, 'getStats', [], { count: 0, lastUpdate: null }),
    getRowControls: () => call(instance, 'getRowControls', [], null),
    supportsRowControls: () =>
      supportsRowControls || typeof instance?.getRowControls === 'function',
    isLoaded: () => instance !== null,
  };

  return new Proxy(target, {
    get(object, property, receiver) {
      if (property === ENSURE_LAZY_LAYER) return ensure;
      if (Reflect.has(object, property))
        return Reflect.get(object, property, receiver);
      if (instance) {
        const value = Reflect.get(instance, property, instance);
        return typeof value === 'function' ? value.bind(instance) : value;
      }
      if (Object.hasOwn(fallbacks, property)) return fallbacks[property];
      if (
        typeof property === 'string' &&
        (property.startsWith('attach') || property === 'setRowControlsListener')
      ) {
        return (...args) => {
          if (instance) return call(instance, property, args);
          deferredAttachments.push([property, args]);
          return undefined;
        };
      }
      return undefined;
    },
  });
}
