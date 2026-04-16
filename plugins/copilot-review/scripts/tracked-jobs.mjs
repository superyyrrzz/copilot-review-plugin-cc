/**
 * Tracked job execution — run a job with automatic state tracking,
 * progress updates, and background task spawning.
 */

import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  writeJobFile,
  upsertJob,
  createJobLogFile,
  appendLogLine,
  appendLogBlock,
  nowIso,
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
      // Update index only — avoids read-modify-write on the per-job file
      // which could clobber concurrent status/pid/result updates.
      // The per-job file's phase is updated by runTrackedJob at key transitions.
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

    // For failed jobs, extract a best-effort error message from the payload
    const errorMessage = completionStatus === "failed"
      ? (execution.payload?.error ?? execution.summary ?? `Exited with status ${execution.exitStatus}`)
      : undefined;

    const finalRecord = {
      ...runningRecord,
      status: completionStatus,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt,
      result: execution.payload ?? null,
      rendered: execution.rendered ?? null,
      summary: execution.summary ?? null,
      ...(errorMessage ? { errorMessage } : {}),
    };

    writeJobFile(cwd, job.id, finalRecord);
    upsertJob(cwd, {
      id: job.id,
      status: completionStatus,
      phase: finalRecord.phase,
      pid: null,
      completedAt,
      summary: execution.summary ?? null,
      ...(errorMessage ? { errorMessage } : {}),
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

  // Write queued state BEFORE spawning so the child can always find the job
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    logFile,
    request,
  };
  writeJobFile(cwd, job.id, queuedRecord);
  upsertJob(cwd, queuedRecord);

  // Spawn detached child running task-worker subcommand
  let child;
  try {
    child = spawn(process.execPath, [
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
  } catch (spawnError) {
    const errorMessage = spawnError?.message ?? String(spawnError);
    const completedAt = nowIso();
    writeJobFile(cwd, job.id, {
      ...queuedRecord,
      status: "failed",
      phase: "failed",
      completedAt,
      errorMessage: `Failed to spawn worker: ${errorMessage}`,
    });
    upsertJob(cwd, {
      id: job.id,
      status: "failed",
      phase: "failed",
      completedAt,
      errorMessage: `Failed to spawn worker: ${errorMessage}`,
    });
    appendLogLine(logFile, `Failed to spawn worker: ${errorMessage}`);
    return { jobId: job.id, logFile, pid: null };
  }

  // Update state index with actual PID now that child is spawned.
  // Only the index is updated — avoid read-modify-write on the per-job file
  // which can race with the worker's initial "running" write and clobber it.
  const pid = child.pid ?? null;
  upsertJob(cwd, { id: job.id, pid });

  return { jobId: job.id, logFile, pid: child.pid };
}

// ---------------------------------------------------------------------------
// Process termination helper
// ---------------------------------------------------------------------------

export function terminateProcessTree(pid) {
  if (!pid) return false;
  // Validate PID is a positive integer to prevent injection
  const numPid = Number(pid);
  if (!Number.isInteger(numPid) || numPid <= 0) return false;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /T /PID ${numPid}`, { stdio: "ignore" });
    } else {
      process.kill(-numPid, "SIGTERM");
    }
    return true;
  } catch {
    try {
      process.kill(numPid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}
