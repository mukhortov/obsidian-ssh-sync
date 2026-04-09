import { describe, it, expect, vi, beforeEach } from "vitest";
import { Poller } from "../../src/sync/poller";

describe("Poller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("starts and stops polling", () => {
    const pollFn = vi.fn();
    const poller = new Poller(pollFn, 60000);

    poller.start();
    vi.advanceTimersByTime(60000);
    expect(pollFn).toHaveBeenCalledTimes(1);

    poller.stop();
    vi.advanceTimersByTime(60000);
    expect(pollFn).toHaveBeenCalledTimes(1);
  });

  it("respects custom interval", () => {
    const pollFn = vi.fn();
    const poller = new Poller(pollFn, 30000);

    poller.start();
    vi.advanceTimersByTime(30000);
    expect(pollFn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30000);
    expect(pollFn).toHaveBeenCalledTimes(2);
  });

  it("does not poll before interval", () => {
    const pollFn = vi.fn();
    const poller = new Poller(pollFn, 60000);

    poller.start();
    vi.advanceTimersByTime(30000);
    expect(pollFn).not.toHaveBeenCalled();
  });

  it("can restart after stop", () => {
    const pollFn = vi.fn();
    const poller = new Poller(pollFn, 60000);

    poller.start();
    vi.advanceTimersByTime(60000);
    expect(pollFn).toHaveBeenCalledTimes(1);

    poller.stop();
    poller.start();
    vi.advanceTimersByTime(60000);
    expect(pollFn).toHaveBeenCalledTimes(2);
  });
});
