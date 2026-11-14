// lib/rate-limit.ts

type LimitRecord = {
  count: number;
  resetTime: number;
};

const ipRecords = new Map<string, LimitRecord>();

export function rateLimit(ip: string, limit = 10, windowMs = 60000) {
  const now = Date.now();
  const record = ipRecords.get(ip);

  if (!record) {
    ipRecords.set(ip, { count: 1, resetTime: now + windowMs });
    return { success: true };
  }

  if (now > record.resetTime) {
    ipRecords.set(ip, { count: 1, resetTime: now + windowMs });
    return { success: true };
  }

  record.count += 1;

  if (record.count > limit) {
    return { success: false };
  }

  return { success: true };
}

if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, record] of ipRecords.entries()) {
      if (now > record.resetTime) {
        ipRecords.delete(key);
      }
    }
  }, 10 * 60 * 1000);
}
