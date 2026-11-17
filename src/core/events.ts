/** Minimal typed synchronous event emitter. */
export class Emitter<T> {
  private handlers: Array<(e: T) => void> = [];

  /** Subscribe; returns an unsubscribe function. */
  on(fn: (e: T) => void): () => void {
    // Copy-on-write: an emit in progress keeps iterating the array it started with.
    this.handlers = [...this.handlers, fn];
    return () => {
      this.handlers = this.handlers.filter((f) => f !== fn);
    };
  }
  emit(e: T): void {
    const hs = this.handlers;
    for (let i = 0; i < hs.length; i++) hs[i]!(e);
  }
  clear(): void {
    this.handlers = [];
  }
}
