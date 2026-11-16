// Retry only operations explicitly known to be safe to repeat. Never wrap arbitrary writes.
export function isTransientD1(error) {
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth++) {
    if (/D1.*(?:overloaded|reset|temporarily|unavailable)|database is locked|SQLITE_BUSY/i.test(current.message || '')) return true;
  }
  return false;
}

export async function retryD1Read(operation, delays = [1000, 3000, 10000]) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!isTransientD1(error) || attempt >= delays.length) throw error;
      await new Promise(resolve => setTimeout(resolve, delays[attempt] + Math.floor(Math.random() * 250)));
    }
  }
}
