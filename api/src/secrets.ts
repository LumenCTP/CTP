// Shared secrets — imported by both index.ts (API) and scheduler.ts (email worker).
//
// In single-process deployments (startScheduler() runs inside the API process) a
// single random fallback is generated once at module load and shared by both.
//
// For multi-process setups (scheduler running as its own process), QUEUE_SECRET env
// var MUST be set identically on both processes — otherwise each process generates
// its own random fallback and queue-authenticated calls between them will 401.
export const QUEUE_SECRET = process.env.QUEUE_SECRET || crypto.randomUUID();
