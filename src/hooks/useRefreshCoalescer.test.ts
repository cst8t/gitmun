import { describe, expect, it, vi } from "vitest";
import { createRefreshCoalescer } from "./useRefreshCoalescer";

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createRefreshCoalescer", () => {
  it("runs the refresh function on trigger", async () => {
    const fn = vi.fn(async () => {});
    const coalescer = createRefreshCoalescer(fn);
    coalescer.trigger();
    await tick();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("coalesces multiple triggers during an in-flight refresh into one trailing run", async () => {
    let resolveFirst: () => void;
    const firstDone = new Promise<void>((r) => { resolveFirst = r; });

    const callOrder: string[] = [];
    const fn = vi.fn(async () => {
      callOrder.push("start");
      await firstDone;
      callOrder.push("end");
    });

    const coalescer = createRefreshCoalescer(fn);

    coalescer.trigger();
    await tick();
    expect(fn).toHaveBeenCalledTimes(1);

    coalescer.trigger();
    coalescer.trigger();
    coalescer.trigger();
    await tick();
    expect(fn).toHaveBeenCalledTimes(1);

    resolveFirst!();
    await tick();

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not queue more than one trailing run", async () => {
    let resolveFirst: () => void;
    const firstDone = new Promise<void>((r) => { resolveFirst = r; });
    let resolveSecond: () => void;
    const secondDone = new Promise<void>((r) => { resolveSecond = r; });

    let callCount = 0;
    const fn = vi.fn(async () => {
      callCount++;
      if (callCount === 1) await firstDone;
      if (callCount === 2) await secondDone;
    });

    const coalescer = createRefreshCoalescer(fn);

    coalescer.trigger();
    await tick();
    coalescer.trigger();
    coalescer.trigger();
    coalescer.trigger();
    await tick();

    resolveFirst!();
    await tick();
    expect(fn).toHaveBeenCalledTimes(2);

    coalescer.trigger();
    coalescer.trigger();
    await tick();

    resolveSecond!();
    await tick();

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("accepts new triggers after reset", async () => {
    const fn = vi.fn(async () => {});
    const coalescer = createRefreshCoalescer(fn);

    coalescer.trigger();
    await tick();
    expect(fn).toHaveBeenCalledTimes(1);

    coalescer.reset();
    coalescer.trigger();
    await tick();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("clears queued work on reset", async () => {
    let resolveFirst: () => void;
    const firstDone = new Promise<void>((r) => { resolveFirst = r; });

    const fn = vi.fn(async () => {
      await firstDone;
    });

    const coalescer = createRefreshCoalescer(fn);
    coalescer.trigger();
    await tick();
    expect(fn).toHaveBeenCalledTimes(1);

    coalescer.trigger();
    coalescer.reset();
    resolveFirst!();
    await tick();

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("queues a new run after reset while a refresh is in flight", async () => {
    let resolveFirst: () => void;
    const firstDone = new Promise<void>((r) => { resolveFirst = r; });
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await firstDone;
    });
    const coalescer = createRefreshCoalescer(fn);

    coalescer.trigger();
    await tick();
    coalescer.reset();
    coalescer.trigger();
    resolveFirst!();
    await tick();

    expect(fn).toHaveBeenCalledTimes(2);
  });
});
