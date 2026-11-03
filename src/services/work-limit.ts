/** Bound expensive work and its queue rather than retaining unlimited requests. */
export class WorkLimit {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly concurrency: number, private readonly queueSize = 0) {}

  acquire(): Promise<() => void> {
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve(this.releaseOnce());
    }
    if (this.waiting.length >= this.queueSize) {
      return Promise.reject(Object.assign(new Error('Server busy; retry shortly'), { statusCode: 503 }));
    }
    return new Promise<void>(resolve => this.waiting.push(resolve)).then(() => this.releaseOnce());
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    };
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try { return await work(); } finally { release(); }
  }
}

export function boundedEnv(key: string, fallback: number, max: number): number {
  const value = Number(process.env[key]);
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

export const passwordWork = new WorkLimit(boundedEnv('PASSWORD_CONCURRENCY', 2, 16), 16);
