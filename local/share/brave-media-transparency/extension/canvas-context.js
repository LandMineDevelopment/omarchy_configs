/* MAIN-world context identity only. No canvas pixels or page content are read. */
(() => {
  const guard = '__braveMediaCanvasContextV1';
  const attribute = 'data-brave-media-canvas-context';
  if (globalThis[guard] || typeof HTMLCanvasElement !== 'function' || typeof Element !== 'function') return;
  const prototype = HTMLCanvasElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'getContext');
  const original = descriptor?.value;
  const setAttribute = Element.prototype.setAttribute;
  const getAttribute = Element.prototype.getAttribute;
  if (typeof original !== 'function' || typeof setAttribute !== 'function' || typeof getAttribute !== 'function') return;
  const wrapped = {
    getContext(...args) {
      // Native conversion, receiver validation, return values and exceptions
      // belong to the original method. Never coerce contextId a second time.
      const context = Reflect.apply(original, this, args);
      if (context) {
        try {
          const mode = args[0] === '2d'
            ? typeof CanvasRenderingContext2D === 'function' && context instanceof CanvasRenderingContext2D ? '2d' : 'unknown'
            : typeof args[0] === 'string' ? args[0] : 'unknown';
          if (Reflect.apply(getAttribute, this, [attribute]) !== mode)
            Reflect.apply(setAttribute, this, [attribute, mode]);
        } catch {
          // A page that cannot be tagged remains unknown and fully protected.
        }
      }
      return context;
    },
  }.getContext;
  try {
    Object.defineProperty(wrapped, 'name', { value: original.name, configurable: true });
    Object.defineProperty(wrapped, 'length', { value: original.length, configurable: true });
    Object.setPrototypeOf(wrapped, Object.getPrototypeOf(original));
    Object.defineProperty(prototype, 'getContext', { ...descriptor, value: wrapped });
    Object.defineProperty(globalThis, guard, { value: true });
  } catch {
    // Unavailable/frozen prototypes are conservative: do not authorize emptiness.
  }
})();
