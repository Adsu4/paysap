const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again after 15 minutes.' }
});

const utrLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many UTR verification requests from this IP. Please try again in 10 minutes.' }
});

const recoveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password recovery attempts. Please try again later.' }
});

// Per-account / per-staff-PIN brute-force protection independent of IP rotation.
class LoginLockoutTracker {
  constructor({ maxFailures = 5, baseLockMs = 60 * 1000, maxLockMs = 15 * 60 * 1000 } = {}) {
    this.maxFailures = maxFailures;
    this.baseLockMs = baseLockMs;
    this.maxLockMs = maxLockMs;
    this.attempts = new Map();
  }

  check(key) {
    if (!key) return { blocked: false, retryAfterSec: 0 };
    const entry = this.attempts.get(key);
    if (!entry || !entry.lockedUntil) return { blocked: false, retryAfterSec: 0 };
    const remaining = entry.lockedUntil - Date.now();
    if (remaining <= 0) return { blocked: false, retryAfterSec: 0 };
    return { blocked: true, retryAfterSec: Math.ceil(remaining / 1000) };
  }

  recordFailure(key) {
    if (!key) return;
    const now = Date.now();
    const prev = this.attempts.get(key) || { count: 0, lockedUntil: 0, lockCount: 0 };
    const count = prev.count + 1;
    let lockedUntil = prev.lockedUntil;
    let lockCount = prev.lockCount;
    if (count >= this.maxFailures) {
      const duration = Math.min(this.maxLockMs, this.baseLockMs * (2 ** lockCount));
      lockedUntil = now + duration;
      lockCount += 1;
    }
    this.attempts.set(key, { count, lockedUntil, lockCount, updatedAt: now });
  }

  clear(key) {
    if (key) this.attempts.delete(key);
  }
}

module.exports = {
  authLimiter,
  utrLimiter,
  recoveryLimiter,
  LoginLockoutTracker
};

