/** Minimal typed synchronous event emitter. */
export class Emitter<T> {
  private handlers: Array<(e: T) => void> = [];

  /** Subscribe; returns an unsubscribe function. */
  on(fn: (e: T) => void): () => void {
    this.handlers.push(fn);
    return () => {
      const i = this.handlers.indexOf(fn);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }
  emit(e: T): void {
    // Copy-free iteration that tolerates unsubscription during emit.
    for (let i = 0; i < this.handlers.length; i++) this.handlers[i]!(e);
  }
  clear(): void {
    this.handlers.length = 0;
  }
}
