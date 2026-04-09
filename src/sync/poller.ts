export class Poller {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private onPoll: () => Promise<void>,
    private intervalMs: number
  ) {}

  start(): void {
    this.stop();
    this.intervalId = setInterval(async () => {
      await this.onPoll();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  updateInterval(intervalMs: number): void {
    this.intervalMs = intervalMs;
    if (this.intervalId) {
      this.start();
    }
  }
}
