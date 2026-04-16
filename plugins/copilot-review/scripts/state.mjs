/**
 * File-based job state management for copilot-review-companion.
 *
 * Stores per-workspace job state under:
 *   $CLAUDE_PLUGIN_DATA/state/<repo>-<hash16>/   (preferred)
 *   os.tmpdir()/copilot-review-companion/<repo>-<hash16>/   (fallback)
 *
 * Layout inside the workspace state dir:
 *   state.json           – lightweight index of all jobs (max 20)
 *   jobs/<jobId>.json     – full job record (request + result)
 *   jobs/<jobId>.log      – append-only progress log
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MAX_JOBS = 20;

function resolveWorkspaceRoot(cwd) {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return cwd;
  }
}

function resolveStateDir(cwd) {
  const root = resolveWorkspaceRoot(cwd);
  const basename = path.basename(root);
  const hash = createHash("sha256").update(fs.realpathSync(root)).digest("hex").slice(0, 16);
  const slug = `${basename}-${hash}`;

  const stateRoot = process.env.CLAUDE_PLUGIN_DATA
    ? path.join(process.env.CLAUDE_PLUGIN_DATA, "state")
    : path.join(os.tmpdir(), "copilot-review-companion");

  return path.join(stateRoot, slug);
}

function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), "jobs");
}

function resolveJobFile(cwd, jobId) {
  validateJobId(jobId);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

function resolveJobLogFile(cwd, jobId) {
  validateJobId(jobId);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

function validateJobId(jobId) {
  if (!jobId || typeof jobId !== "string") {
    throw new Error("Invalid job ID: must be a non-empty string");
  }
  // Reject path traversal, separators, and non-alphanumeric except dash
  if (/[^a-zA-Z0-9\-]/.test(jobId) || jobId.includes("..")) {
    throw new Error(`Invalid job ID: "${jobId}" contains disallowed characters`);
  }
}

function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), "state.json");
}

function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function nowIso() {
  return new Date().toISOString();
}

export function generateJobId(prefix = "review") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

// ---------------------------------------------------------------------------
// state.json — lightweight index
// ---------------------------------------------------------------------------

function defaultState() {
  return { version: 1, jobs: [] };
}

export function readState(cwd) {
  const file = resolveStateFile(cwd);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return defaultState();
  }
}

export function updateState(cwd, mutator) {
  ensureStateDir(cwd);
  const stateFile = resolveStateFile(cwd);

  // Retry loop for concurrent access
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = readState(cwd);
    mutator(state);
    // Prune to MAX_JOBS, sorted by updatedAt desc
    state.jobs.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    const pruned = state.jobs.splice(MAX_JOBS);
    // Delete pruned job files
    for (const job of pruned) {
      try { fs.unlinkSync(resolveJobFile(cwd, job.id)); } catch {}
      try { fs.unlinkSync(resolveJobLogFile(cwd, job.id)); } catch {}
    }
    // Atomic write via temp file + rename
    const tmpFile = stateFile + `.tmp.${process.pid}.${Date.now()}`;
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2) + "\n", "utf8");
      fs.renameSync(tmpFile, stateFile);
      return state;
    } catch (err) {
      try { fs.unlinkSync(tmpFile); } catch {}
      if (attempt < 2) continue;
      // Last attempt: fall back to direct write
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
      return state;
    }
  }
}

// ---------------------------------------------------------------------------
// Job index operations
// ---------------------------------------------------------------------------

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const idx = state.jobs.findIndex((j) => j.id === jobPatch.id);
    if (idx === -1) {
      state.jobs.unshift({ createdAt: timestamp, updatedAt: timestamp, ...jobPatch });
    } else {
      state.jobs[idx] = { ...state.jobs[idx], ...jobPatch, updatedAt: timestamp };
    }
  });
}

// ---------------------------------------------------------------------------
// Per-job file operations
// ---------------------------------------------------------------------------

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const file = resolveJobFile(cwd, jobId);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return file;
}

export function readStoredJob(cwd, jobId) {
  const file = resolveJobFile(cwd, jobId);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Log file operations
// ---------------------------------------------------------------------------

export function createJobLogFile(cwd, jobId, title) {
  ensureStateDir(cwd);
  const logFile = resolveJobLogFile(cwd, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) return;
  try {
    fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
  } catch {}
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) return;
  try {
    fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
  } catch {}
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export function listJobs(cwd, { sessionId, all } = {}) {
  const state = readState(cwd);
  if (all) return state.jobs;
  if (sessionId) return state.jobs.filter((j) => j.sessionId === sessionId);
  // No session ID and not --all: return all jobs (best-effort in absence of session tracking)
  return state.jobs;
}

export function findLatestJob(cwd, { sessionId, activeOnly } = {}) {
  const jobs = listJobs(cwd, { sessionId });
  if (activeOnly) return jobs.find((j) => isActiveJobStatus(j.status));
  return jobs[0] ?? null;
}

export { resolveWorkspaceRoot, resolveStateDir, resolveJobFile, resolveJobLogFile, isActiveJobStatus };
