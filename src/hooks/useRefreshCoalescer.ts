export interface RefreshCoalescer {
  trigger: () => void;
  reset: () => void;
}

export function createRefreshCoalescer(
  refreshFn: () => Promise<void>,
): RefreshCoalescer {
  let inFlight = false;
  let queued = false;

  async function run(): Promise<void> {
    inFlight = true;
    queued = false;
    try {
      await refreshFn();
    } finally {
      inFlight = false;
      if (queued) {
        void run();
      }
    }
  }

  return {
    trigger() {
      if (inFlight) {
        queued = true;
      } else {
        void run();
      }
    },
    reset() {
      queued = false;
    },
  };
}
