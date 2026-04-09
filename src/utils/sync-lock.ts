/**
 * Serializes async operations so only one runs at a time.
 * Callers wait for the previous operation to finish before starting.
 */
export class SyncLock {
  private lockPromise: Promise<void> = Promise.resolve();
  private _isLocked = false;

  get isLocked(): boolean {
    return this._isLocked;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lockPromise;
    let resolve: () => void;
    this.lockPromise = new Promise<void>((r) => { resolve = r; });
    return prev.then(async () => {
      this._isLocked = true;
      try {
        return await fn();
      } finally {
        this._isLocked = false;
        resolve!();
      }
    });
  }
}
