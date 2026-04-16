/**
 * Tracked job execution — run a job with automatic state tracking,
 * progress updates, and background task spawning.
 */

import fs from "node:fs";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  writeJobFile,
  readStoredJob,
  upsertJob,
  createJobLogFile,
  appendLogLine,
  appendLogBlock,
  nowIso,
  isActiveJobStatus,
} from "./state.mjs";

const __filename = fileURLToPath(import.meta.url);
const COMPANION_SCRIPT = path.resolve(path.dirname(__filename), "copilot-acp-companion.mjs");

// ---------------------------------------------------------------------------
// Progress updater — writes phase changes to state.json
// ---------------------------------------------------------------------------

export function createJobProgressUpdater(cwd, jobId) {
  let lastPhase = null;
  return (phase) => {
    if (phase === lastPhase) return;
    lastPhase = phase;
    try {
      // Only update if job file still exists (guard against pruned jobs)
      const stored = readStoredJob(cwd, jobId);
      if (!stored) return;
      upsertJob(cwd, { id: jobId, phase });
    } catch {}
  };
}

// ---------------------------------------------------------------------------
// runTrackedJob — wraps a runner with state tracking
// ---------------------------------------------------------------------------

export async function runTrackedJob(job, runner, { logFile } = {}) {
  const cwd = job.workspaceRoot;

  // Mark running
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: logFile ?? job.logFile ?? null,
  };
  writeJobFile(cwd, job.id, runningRecord);
  upsertJob(cwd, runningRecord);

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();

    const finalRecord = {
      ...runningRecord,
      status: completionStatus,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt,
      result: execution.payload ?? null,
      rendered: execution.rendered ?? null,
      summary: execution.summary ?? null,
    };

    writeJobFile(cwd, job.id, finalRecord);
    upsertJob(cwd, {
      id: job.id,
      status: completionStatus,
      phase: finalRecord.phase,
      pid: null,
      completedAt,
      summary: execution.summary ?? null,
    });

    if (logFile && execution.rendered) {
      appendLogBlock(logFile, "Final output", execution.rendered);
    }

    return execution;
  } catch (error) {
    const completedAt = nowIso();
    const errorMessage = error?.message ?? String(error);

    writeJobFile(cwd, job.id, {
      ...runningRecord,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt,
      errorMessage,
    });
    upsertJob(cwd, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt,
      errorMessage,
    });
    if (logFile) {
      appendLogLine(logFile, `Error: ${errorMessage}`);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// enqueueBackgroundTask — spawn detached task-worker child
// ---------------------------------------------------------------------------

export function enqueueBackgroundTask(cwd, job, request) {
  const logFile = createJobLogFile(cwd, job.id, job.title ?? "Copilot Review");
  appendLogLine(logFile, "Queued for background execution.");

  // Spawn detached child running task-worker subcommand
  const child = spawn(process.execPath, [
    COMPANION_SCRIPT,
    "task-worker",
    "--cwd", cwd,
    "--job-id", job.id,
  ], {
    cwd,
    env: {
      ...process.env,
      ...(job.sessionId ? { COPILOT_REVIEW_SESSION_ID: job.sessionId } : {}),
    },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  // Write queued state
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request,
  };
  writeJobFile(cwd, job.id, queuedRecord);
  upsertJob(cwd, queuedRecord);

  return { jobId: job.id, logFile, pid: child.pid };
}

// ---------------------------------------------------------------------------
// Process termination helper
// ---------------------------------------------------------------------------

export function terminateProcessTree(pid) {
  if (!pid) return false;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGTERM");
    }
    return true;
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}
