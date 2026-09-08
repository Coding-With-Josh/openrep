import { getServerConfig } from "./config";

interface Bucket {
  windowStart: number;
  count: number;
}

const SWEEP_THRESHOLD = 10_000;

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.windowStart + this.windowMs <= now) {
      this.buckets.set(key, { windowStart: now, count: 1 });
      this.sweep(now);
      return true;
    }
    if (bucket.count >= this.maxRequests) {
      return false;
    }
    bucket.count += 1;
    return true;
  }

  private sweep(now: number): void {
    if (this.buckets.size < SWEEP_THRESHOLD) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.windowStart + this.windowMs <= now) {
        this.buckets.delete(key);
      }
    }
  }
}

let singleton: FixedWindowRateLimiter | null = null;

export function getRateLimiter(): FixedWindowRateLimiter {
  if (singleton === null) {
    const config = getServerConfig();
    singleton = new FixedWindowRateLimiter(config.rateLimitWindowMs, config.rateLimitMaxRequests);
  }
  return singleton;
}