// Lightweight pub/sub for decoupled UI refresh and lifecycle signals.

export function createEventBus() {
  const target = new EventTarget();
  return {
    on(type, handler) {
      target.addEventListener(type, handler);
      return () => target.removeEventListener(type, handler);
    },
    emit(type, detail) {
      target.dispatchEvent(new CustomEvent(type, { detail }));
    },
  };
}
