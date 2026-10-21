import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderProgressUpdates, ReaderSeekController } from "../../src/shared/readerProgress";

beforeEach(() => vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

describe("live reader progress", () => {
  it("publishes during continuous input and flushes the final snapshot", () => {
    const published: number[] = [];
    const updates = new ReaderProgressUpdates<number>((value) => published.push(value));
    for (let value = 0; value < 20; value++) {
      updates.push(value);
      vi.advanceTimersByTime(20);
    }
    expect(published).toEqual([0, 4, 9, 14, 19]);
    updates.push(20);
    updates.flush();
    expect(published.at(-1)).toBe(20);
    updates.push(21);
    updates.cancel();
    vi.advanceTimersByTime(1000);
    expect(published.at(-1)).toBe(20);
  });
});

describe("slider preview and asynchronous positioning", () => {
  it("keeps the latest preview while held and immediately commits the final target", async () => {
    const preview = vi.fn();
    const release: Array<(value: boolean) => void> = [];
    const applied: number[] = [];
    const seek = new ReaderSeekController((value) => {
      applied.push(value);
      return new Promise<boolean>((resolve) => release.push(resolve));
    }, preview, vi.fn());
    seek.begin();
    seek.input(100);
    seek.input(200);
    seek.input(300);
    expect(preview.mock.calls).toEqual([[100], [200], [300]]);
    expect(applied).toEqual([100]);
    release.shift()!(true);
    await vi.advanceTimersByTimeAsync(99);
    expect(applied).toEqual([100]);
    expect(preview).toHaveBeenLastCalledWith(300);
    seek.finish();
    expect(applied).toEqual([100, 300]);
    release.shift()!(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(preview).toHaveBeenLastCalledWith(undefined);
  });

  it("holds completed previews until release and clears cancelled/failed seeks", async () => {
    const preview = vi.fn();
    const failed = vi.fn();
    const apply = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("failed"));
    const seek = new ReaderSeekController(apply, preview, failed);
    seek.begin();
    seek.input(200);
    await vi.advanceTimersByTimeAsync(100);
    expect(preview).toHaveBeenLastCalledWith(200);
    seek.finish();
    expect(preview).toHaveBeenLastCalledWith(undefined);
    seek.input(300);
    await vi.advanceTimersByTimeAsync(100);
    expect(preview).toHaveBeenLastCalledWith(undefined);
    expect(failed).not.toHaveBeenCalled();
    seek.input(400);
    await vi.advanceTimersByTimeAsync(100);
    expect(failed).toHaveBeenCalledOnce();
  });

  it("does not publish or apply delayed work after unmount", async () => {
    const preview = vi.fn();
    let release!: (value: boolean) => void;
    const apply = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const seek = new ReaderSeekController(apply, preview, vi.fn());
    seek.input(100);
    seek.input(200);
    seek.dispose();
    release(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(apply).toHaveBeenCalledOnce();
    expect(preview.mock.calls).toEqual([[100], [200]]);
  });
});
