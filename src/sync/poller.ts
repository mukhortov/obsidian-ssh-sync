/** Opaque timer handle — works in both Obsidian (number) and Node (Timeout). */
type TimerHandle = ReturnType<typeof setInterval>;

export class Poller {
  private intervalId: TimerHandle | null = null;

  constructor(
    private onPoll: () => Promise<void>,
    private intervalMs: number
  ) {}

  start(): void {
    this.stop();
    if (typeof window !== "undefined") {
      this.intervalId = window.activeWindow.setInterval(() => {
        void this.onPoll();
      }, this.intervalMs) as unknown as TimerHandle;
    } else {
      // eslint-disable-next-line obsidianmd/prefer-active-window-timers -- Node test env fallback
      this.intervalId = setInterval(() => {
        void this.onPoll();
      }, this.intervalMs);
    }
  }

  stop(): void {
    if (this.intervalId !== null) {
      if (typeof window !== "undefined") {
        window.activeWindow.clearInterval(this.intervalId as unknown as number);
      } else {
        // eslint-disable-next-line obsidianmd/prefer-active-window-timers -- Node test env fallback
        clearInterval(this.intervalId);
      }
      this.intervalId = null;
    }
  }

  updateInterval(intervalMs: number): void {
    this.intervalMs = intervalMs;
    if (this.intervalId !== null) {
      this.start();
    }
  }
}
