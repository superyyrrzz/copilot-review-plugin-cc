#!/usr/bin/env node
/**
 * Copilot ACP Companion — drives GitHub Copilot CLI via the Agent Client
 * Protocol (ACP) over stdio for structured, session-based code reviews.
 *
 * Usage:  node copilot-acp-companion.mjs review [options]
 */

// Suppress Node.js DEP0190 (shell+args) — unavoidable when resolving npm on Windows
process.removeAllListeners("warning");
const originalEmit = process.emit.bind(process);
process.emit = function (event, ...args) {
  if (event === "warning" && args[0]?.code === "DEP0190") return false;
  return originalEmit(event, ...args);
};

import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import process from "node:process";
import path from "node:path";
import fs from "node:fs";
import {
  generateJobId,
  readStoredJob,
  upsertJob,
  writeJobFile,
  appendLogLine,
  createJobLogFile,
  nowIso,
  listJobs,
  isActiveJobStatus,
} from "./state.mjs";
import {
  runTrackedJob,
  createJobProgressUpdater,
  enqueueBackgroundTask,
  terminateProcessTree,
} from "./tracked-jobs.mjs";

// ---------------------------------------------------------------------------
// Argument parsing (inlined from codex-plugin-cc/scripts/lib/args.mjs)
// ---------------------------------------------------------------------------

function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) { positionals.push(token); continue; }
    if (token === "--") { passthrough = true; continue; }
    if (!token.startsWith("-") || token === "-") { positionals.push(token); continue; }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }
      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined || (inlineValue === undefined && nextValue.startsWith("-"))) throw new Error(`Missing value for --${rawKey}`);
        options[key] = nextValue;
        if (inlineValue === undefined) index += 1;
        continue;
      }
      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;
    if (booleanOptions.has(key)) { options[key] = true; continue; }
    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined || nextValue.startsWith("-")) throw new Error(`Missing value for -${shortKey}`);
      options[key] = nextValue;
      index += 1;
      continue;
    }
    positionals.push(token);
  }

  return { options, positionals };
}

// ---------------------------------------------------------------------------
// ACP Client
// ---------------------------------------------------------------------------

class AcpClient {
  constructor(cwd) {
    this.cwd = cwd;
    this.proc = null;
    this.rl = null;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.stderr = "";
    this.notificationHandler = null;
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    this.exitResolved = false;
    this.sessionId = null;
    this.debugLog = null;
  }

  async connect() {
    // Resolve the copilot binary. On Windows, prefer the native .exe to avoid
    // shell:true (which triggers Node DEP0190 on recent versions).
    let command = "copilot";
    let useShell = false;
    if (process.platform === "win32") {
      // Try to find the native binary shipped by @github/copilot
      const archPackage = {
        x64: "copilot-win32-x64",
        arm64: "copilot-win32-arm64",
        ia32: "copilot-win32-ia32",
      }[process.arch];
      if (archPackage) {
        const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: true }).stdout?.trim();
        if (npmRoot) {
          const nativeBin = path.join(npmRoot, "@github", "copilot", "node_modules",
            "@github", archPackage, "copilot.exe");
          if (fs.existsSync(nativeBin)) {
            command = nativeBin;
          } else {
            useShell = true;
          }
        } else {
          useShell = true;
        }
      } else {
        useShell = true;
      }
    }

    // Always use --allow-all-tools in ACP mode. The companion script runs
    // non-interactive code reviews where tool rejections degrade quality.
    // Permission requests are still handled via session/request_permission
    // as a secondary gate.
    const copilotArgs = ["--acp", "--no-auto-update", "--allow-all-tools"];

    this.proc = spawn(
      command,
      copilotArgs,
      { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], ...(useShell ? { shell: true } : {}) }
    );

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.proc.stdin.on("error", (err) => { if (!this.closed) this.handleExit(err); });
    this.proc.on("error", (err) => this.handleExit(err));
    this.proc.on("exit", (code, signal) => {
      this.handleExit(
        code === 0
          ? null
          : new Error(`copilot --acp exited (${signal ? `signal ${signal}` : `code ${code}`})`)
      );
    });

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.handleLine(line));

    // ACP handshake
    await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "copilot-acp-companion", version: "1.0.0" },
    });
    this.notify("notifications/initialized", {});
  }

  async newSession() {
    const result = await this.request("session/new", {
      cwd: this.cwd,
      mcpServers: [],
    });
    this.sessionId = result.sessionId;
    return result;
  }

  async prompt(text, { onChunk } = {}) {
    if (!this.sessionId) throw new Error("No active session. Call newSession() first.");

    let fullText = "";
    const prevHandler = this.notificationHandler;
    const pendingTools = new Map(); // toolCallId → { title, kind, path, cmd }

    this.notificationHandler = (msg) => {
      if (
        msg.method === "session/update" &&
        msg.params?.sessionId === this.sessionId
      ) {
        const update = msg.params.update;
        // ACP sends text chunks as update.content.text or update.text depending on version
        const chunkText = update?.content?.text ?? update?.text;
        if (update?.sessionUpdate === "agent_message_chunk" && chunkText) {
          fullText += chunkText;
          if (onChunk) onChunk("text", chunkText);
        } else if (update?.sessionUpdate === "agent_thought_chunk" && onChunk) {
          const thoughtText = update?.content?.text ?? update?.text;
          if (thoughtText) onChunk("thought", thoughtText);
        } else if (update?.sessionUpdate === "tool_call" && onChunk) {
          const id = update.toolCallId ?? "";
          const kind = update.kind ?? "";
          const path = update.rawInput?.path ?? update.locations?.[0]?.path ?? "";
          const cmd = update.rawInput?.command ?? "";
          const title = update.title ?? update.rawInput?.description ?? "";
          const shortPath = path ? path.split(/[\\/]/).slice(-3).join("/") : "";
          const shortCmd = cmd ? (cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd) : "";
          const label = kind === "read" && shortPath ? `Reading ${shortPath}`
            : kind === "execute" && shortCmd ? `Running: ${shortCmd}`
            : title || `${kind || "tool"} call`;
          pendingTools.set(id, { label, kind });
          onChunk("tool_start", label);
        } else if (update?.sessionUpdate === "tool_call_update" && onChunk) {
          const id = update.toolCallId ?? "";
          const status = update.status ?? "";
          const info = pendingTools.get(id);
          const label = info?.label ?? id.slice(0, 12);
          if (status === "completed") {
            pendingTools.delete(id);
            onChunk("tool_done", label);
          } else if (status === "failed") {
            pendingTools.delete(id);
            const reason = update.rawOutput?.message ?? "unknown";
            onChunk("tool_fail", `${label}: ${reason}`);
          }
        }
        return;
      }
      if (prevHandler) prevHandler(msg);
    };

    try {
      const result = await this.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      });
      return { fullText, stopReason: result.stopReason ?? "unknown" };
    } finally {
      this.notificationHandler = prevHandler;
    }
  }

  async cancel() {
    if (this.sessionId && !this.closed) {
      try {
        await this.request("session/cancel", { sessionId: this.sessionId });
      } catch {
        // best-effort
      }
    }
  }

  async close() {
    if (this.closed) { await this.exitPromise; return; }
    this.closed = true;
    if (this.rl) this.rl.close();
    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      const timer = setTimeout(() => {
        if (this.proc && !this.proc.killed) this.proc.kill("SIGTERM");
      }, 50);
      timer.unref?.();
    }
    await this.exitPromise;
  }

  // --- internal plumbing ---

  request(method, params) {
    if (this.closed) throw new Error("ACP client is closed.");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.sendMessage({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params = {}) {
    if (this.closed) return;
    this.sendMessage({ jsonrpc: "2.0", method, params });
  }

  sendMessage(msg) {
    if (!this.proc?.stdin) throw new Error("ACP stdin not available.");
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (this.debugLog) this.debugLog(msg);

    // Server-initiated request (has both id and method) — e.g. session/request_permission
    if (msg.id !== undefined && msg.method) {
      if (msg.method === "session/request_permission") {
        const options = msg.params?.options ?? [];
        const toolKind = msg.params?.toolCall?.kind ?? "";
        // For execute/shell commands, use allow_always (allow_once doesn't persist
        // through the ACP lifecycle for execute permissions).
        // For read/other, use allow_once to scope narrowly.
        const preferredKind = toolKind === "execute" ? "allow_always" : "allow_once";
        const chosen = options.find(o => o.kind === preferredKind)
          ?? options.find(o => o.kind === "allow_once")
          ?? options.find(o => o.kind === "allow_always");
        if (chosen) {
          this.sendMessage({
            jsonrpc: "2.0",
            id: msg.id,
            result: { optionId: chosen.optionId },
          });
        } else {
          // No approval option available — reject using provided reject option or error
          const reject = options.find(o => o.kind === "reject_once");
          if (reject) {
            this.sendMessage({
              jsonrpc: "2.0",
              id: msg.id,
              result: { optionId: reject.optionId },
            });
          } else {
            this.sendMessage({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32600, message: "No acceptable permission option available" },
            });
          }
        }
      } else {
        // Unknown server request — respond with method not found
        this.sendMessage({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "Method not found" },
        });
      }
      return;
    }

    // Response to a request we sent
    if (msg.id !== undefined && !msg.method) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message ?? `ACP ${entry.method} failed`);
        err.data = msg.error;
        entry.reject(err);
      } else {
        entry.resolve(msg.result ?? {});
      }
      return;
    }

    // Notification from agent
    if (msg.method && this.notificationHandler) {
      this.notificationHandler(msg);
    }
  }

  handleExit(error) {
    if (this.exitResolved) return;
    this.exitResolved = true;
    this.closed = true;
    for (const entry of this.pending.values()) {
      entry.reject(error ?? new Error("ACP connection closed."));
    }
    this.pending.clear();
    this.resolveExit();
  }
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

const MAX_DIFF_BYTES = 100 * 1024;

function git(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`Failed to run "git ${args.join(" ")}": ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(`"git ${args.join(" ")}" exited with status ${result.status}${stderr ? `: ${stderr}` : ""}`);
  }
  return result.stdout ?? "";
}

function collectDiff(cwd, base) {
  let diff;
  if (base) {
    diff = git(["diff", "--no-color", "--no-ext-diff", `${base}...HEAD`], cwd);
  } else {
    diff = git(["diff", "--no-color", "--no-ext-diff", "HEAD"], cwd);
  }
  if (!diff.trim()) return null;
  if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) {
    diff = diff.slice(0, MAX_DIFF_BYTES) + "\n\n[... diff truncated at 100 KB ...]";
  }
  return diff;
}

function getRepoRoot(cwd) {
  return git(["rev-parse", "--show-toplevel"], cwd).trim() || cwd;
}

// ---------------------------------------------------------------------------
// Review prompt
// ---------------------------------------------------------------------------

function buildReviewPrompt(diffText, options = {}) {
  const focus = options.focus ? `\nAdditional focus: ${options.focus}\n` : "";
  return `Review the following code changes. Focus on bugs, logic errors, security issues, performance problems, and code quality concerns.

For each finding, report it as:
[file:line] severity (high/medium/low): description

If there are no issues, say "No issues found."
${focus}
\`\`\`\`diff
${diffText}
\`\`\`\``;
}

// ---------------------------------------------------------------------------
// Review handler
// ---------------------------------------------------------------------------

async function handleReview(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd", "base", "timeout", "idle-timeout", "job-id"],
    booleanOptions: ["json", "stream", "debug", "background"],
    aliasMap: { C: "cwd" },
  });

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const base = options.base != null && String(options.base).trim() !== "" ? String(options.base).trim() : null;
  const jsonOutput = Boolean(options.json);
  const stream = Boolean(options.stream);
  const debug = Boolean(options.debug);
  let timeoutMs = 1800000; // 30 min wall-clock safety valve
  if (options.timeout !== undefined) {
    const raw = String(options.timeout);
    timeoutMs = Number(raw);
    if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || raw !== String(timeoutMs)) {
      const msg = `Invalid --timeout value: "${options.timeout}" (must be a positive integer in ms)`;
      process.stderr.write(msg + "\n");
      if (jsonOutput) {
        console.log(JSON.stringify({ review: null, stopReason: null, base: base ?? "working-tree", error: msg, exitCode: 1 }));
      }
      process.exitCode = 1;
      return;
    }
  }
  let idleTimeoutMs = 120000; // 2 min idle timeout
  if (options["idle-timeout"] !== undefined) {
    const raw = String(options["idle-timeout"]);
    idleTimeoutMs = Number(raw);
    if (!Number.isFinite(idleTimeoutMs) || !Number.isInteger(idleTimeoutMs) || idleTimeoutMs <= 0 || raw !== String(idleTimeoutMs)) {
      const msg = `Invalid --idle-timeout value: "${options["idle-timeout"]}" (must be a positive integer in ms)`;
      process.stderr.write(msg + "\n");
      if (jsonOutput) {
        console.log(JSON.stringify({ review: null, stopReason: null, base: base ?? "working-tree", error: msg, exitCode: 1 }));
      }
      process.exitCode = 1;
      return;
    }
  }
  const focus = positionals.join(" ").trim() || null;
  const background = Boolean(options.background);
  const jobId = options["job-id"] ?? null;

  // Background mode: enqueue and exit immediately
  if (background) {
    const workspaceRoot = getRepoRoot(cwd);
    const id = generateJobId("review");
    const sessionId = process.env.COPILOT_REVIEW_SESSION_ID || undefined;
    const job = {
      id,
      kind: "review",
      title: "Copilot Review",
      workspaceRoot,
      summary: `Review ${base ?? "working-tree"}`,
      ...(sessionId ? { sessionId } : {}),
    };
    // Store the original argv, stripping all --background variants to prevent re-enqueue
    const request = { argv: argv.filter((a) => !a.startsWith("--background")) };
    const result = enqueueBackgroundTask(cwd, job, request);
    // Output job info to stdout so caller can parse it
    const spawnFailed = result.pid == null;
    console.log(JSON.stringify({
      jobId: id,
      status: spawnFailed ? "failed" : "queued",
      logFile: result.logFile,
      pid: result.pid,
    }));
    if (spawnFailed) process.exitCode = 1;
    return;
  }

  // Resolve job tracking context (set when running as task-worker or with --job-id)
  let logFile = null;
  let progressUpdater = null;
  if (jobId) {
    const workspaceRoot = getRepoRoot(cwd);
    const stored = safeReadJob(workspaceRoot, jobId);
    if (stored === undefined) return; // invalid ID
    if (stored) {
      logFile = stored.logFile ?? null;
      progressUpdater = createJobProgressUpdater(workspaceRoot, jobId);
    }
  }

  // Collect diff
  let diff;
  try {
    diff = collectDiff(cwd, base);
  } catch (err) {
    process.stderr.write(`Diff collection error: ${err.message}\n`);
    if (jsonOutput) {
      console.log(JSON.stringify({ review: null, stopReason: null, base: base ?? "working-tree", error: err.message, exitCode: 1 }));
    }
    process.exitCode = 1;
    return;
  }
  if (!diff) {
    const msg = "No changes found to review.";
    if (jsonOutput) {
      console.log(JSON.stringify({ review: msg, stopReason: null, base: base ?? "working-tree", exitCode: 0 }));
    } else {
      console.log(msg);
    }
    return;
  }

  const prompt = buildReviewPrompt(diff, { focus });

  // ACP session
  const client = new AcpClient(getRepoRoot(cwd));
  if (debug) {
    client.debugLog = (msg) => {
      // For session/update notifications, dump the full update object
      if (msg.method === "session/update" && msg.params?.update) {
        const u = msg.params.update;
        // Truncate large text fields to keep output readable
        const sanitized = JSON.stringify(u, (key, val) => {
          if (typeof val === "string" && val.length > 300) return val.slice(0, 300) + "...[truncated]";
          return val;
        });
        process.stderr.write("[debug:update] " + sanitized + "\n");
      } else if (msg.id !== undefined && msg.method) {
        // Server-initiated request (e.g. session/request_permission)
        const text = JSON.stringify(msg);
        process.stderr.write("[debug:server-request] " + (text.length > 1000 ? text.slice(0, 1000) + "..." : text) + "\n");
      } else if (msg.id !== undefined && !msg.method) {
        // Response to our request
        const text = JSON.stringify(msg);
        process.stderr.write("[debug:response] " + (text.length > 1000 ? text.slice(0, 1000) + "..." : text) + "\n");
      }
    };
  }
  let timedOut = false;

  async function handleTimeout(reason, errorKey) {
    try {
      timedOut = true;
      process.stderr.write(`${reason}\n`);
      if (jsonOutput) {
        console.log(JSON.stringify({ review: null, stopReason: null, base: base ?? "working-tree", error: errorKey, exitCode: 1 }));
      }
      await client.cancel();
      await client.close();
      process.exitCode = 1;
    } catch (err) {
      process.stderr.write(`ACP timeout error: ${err.message}\n`);
    }
  }

  // Wall-clock safety valve (--timeout, default 30 min)
  const maxTimer = setTimeout(
    () => handleTimeout(
      `Review max-timed out (exceeded ${(timeoutMs / 1000).toFixed(0)}s wall clock). Cancelling...`,
      "max_timeout"
    ),
    timeoutMs
  );
  maxTimer.unref?.();

  // Activity-based idle timer (--idle-timeout, default 2 min)
  const idleTimeoutHandler = () => handleTimeout(
    `Review idle-timed out (no activity for ${(idleTimeoutMs / 1000).toFixed(0)}s). Cancelling...`,
    "idle_timeout"
  );
  let idleTimer = setTimeout(idleTimeoutHandler, idleTimeoutMs);
  idleTimer.unref?.();

  function resetIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(idleTimeoutHandler, idleTimeoutMs);
    idleTimer.unref?.();
  }

  try {
    await client.connect();
    const startTime = Date.now();
    const elapsed = () => `${((Date.now() - startTime) / 1000).toFixed(0)}s`;
    process.stderr.write(`[copilot] Connected. Reviewing...\n`);
    if (logFile) appendLogLine(logFile, "Connected. Reviewing...");
    await client.newSession();

    let phase = "thinking";
    let thoughtBuffer = "";
    let lastThoughtSummary = "";

    const onChunk = (kind, data) => {
      resetIdleTimer();
      if (kind === "text") {
        // Response text is the final review — just accumulate (shown on stdout at end)
        // But if --stream, also show it live
        if (stream) process.stderr.write(data);
      } else if (kind === "thought") {
        thoughtBuffer += data;
        // Extract meaningful sentences from thought buffer to show phase changes
        const sentences = thoughtBuffer.split(/[.!?]\s+/);
        if (sentences.length > 1) {
          const latest = sentences[sentences.length - 2].trim().replace(/\s+/g, " ");
          if (latest && latest.length > 20 && latest !== lastThoughtSummary) {
            lastThoughtSummary = latest;
            if (phase !== "thinking") {
              phase = "thinking";
            }
            process.stderr.write(`[${elapsed()}] ${latest}.\n`);
            if (logFile) appendLogLine(logFile, latest);
            if (progressUpdater) progressUpdater("thinking");
          }
          thoughtBuffer = sentences[sentences.length - 1]; // keep incomplete sentence
        }
      } else if (kind === "tool_start") {
        phase = "investigating";
        process.stderr.write(`[${elapsed()}] ${data}\n`);
        if (logFile) appendLogLine(logFile, data);
        if (progressUpdater) progressUpdater("investigating");
      } else if (kind === "tool_done") {
        // Silently complete — the start message was enough
      } else if (kind === "tool_fail") {
        process.stderr.write(`[${elapsed()}] Failed: ${data}\n`);
        if (logFile) appendLogLine(logFile, `Failed: ${data}`);
      }
    };

    const result = await client.prompt(prompt, { onChunk });
    clearTimeout(maxTimer);
    clearTimeout(idleTimer);

    process.stderr.write(`[${elapsed()}] Review complete.\n`);
    if (logFile) appendLogLine(logFile, "Review complete.");

    if (timedOut) return;

    if (jsonOutput) {
      console.log(JSON.stringify({
        review: result.fullText,
        stopReason: result.stopReason,
        base: base ?? "working-tree",
        exitCode: 0,
      }));
    } else {
      console.log(result.fullText);
    }
  } catch (err) {
    clearTimeout(maxTimer);
    clearTimeout(idleTimer);
    if (timedOut) return;
    process.stderr.write(`ACP error: ${err.message}\n`);
    if (client.stderr) process.stderr.write(client.stderr);
    if (jsonOutput) {
      console.log(JSON.stringify({ review: null, stopReason: null, base: base ?? "working-tree", error: err.message, exitCode: 1 }));
    }
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// Safe job lookup — validates jobId and returns null on invalid input
// ---------------------------------------------------------------------------

function safeReadJob(workspaceRoot, jobId) {
  try {
    return readStoredJob(workspaceRoot, jobId);
  } catch (err) {
    console.log(`Invalid job ID: ${jobId}`);
    process.exitCode = 1;
    return undefined; // distinct from null (not found) — signals caller to return early
  }
}

// ---------------------------------------------------------------------------
// Status handler
// ---------------------------------------------------------------------------

async function handleStatus(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd", "timeout-ms"],
    booleanOptions: ["wait", "all"],
    aliasMap: { C: "cwd" },
  });

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const workspaceRoot = getRepoRoot(cwd);
  const jobId = positionals[0] ?? null;
  const waitMode = Boolean(options.wait);
  const showAll = Boolean(options.all);
  const rawTimeout = options["timeout-ms"] != null ? Number(options["timeout-ms"]) : NaN;
  const waitTimeout = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 240000;

  if (jobId) {
    // Single job view
    const job = safeReadJob(workspaceRoot, jobId);
    if (job === undefined) return; // invalid ID
    if (!job) {
      console.log(`Job not found: ${jobId}`);
      process.exitCode = 1;
      return;
    }

    if (waitMode && isActiveJobStatus(job.status)) {
      // Poll until done
      const deadline = Date.now() + waitTimeout;
      let current = job;
      while (isActiveJobStatus(current.status) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        current = readStoredJob(workspaceRoot, jobId) ?? current;
      }
      if (isActiveJobStatus(current.status)) {
        console.log(`Timed out waiting for job ${jobId} (still ${current.status} after ${formatDuration(waitTimeout)}).`);
        process.exitCode = 1;
      }
      printJobDetail(current);
    } else {
      printJobDetail(job);
    }
  } else {
    // List all jobs
    const sessionId = process.env.COPILOT_REVIEW_SESSION_ID || undefined;
    const jobs = listJobs(workspaceRoot, { sessionId: showAll ? undefined : sessionId, all: showAll });
    if (jobs.length === 0) {
      console.log("No review jobs found.");
      return;
    }
    printJobTable(jobs);
  }
}

function printJobDetail(job) {
  const lines = [
    `Job: ${job.id}`,
    `Status: ${job.status}`,
    `Phase: ${job.phase ?? "—"}`,
    `Summary: ${job.summary ?? "—"}`,
  ];
  if (job.startedAt) lines.push(`Started: ${job.startedAt}`);
  if (job.completedAt) lines.push(`Completed: ${job.completedAt}`);
  if (job.errorMessage) lines.push(`Error: ${job.errorMessage}`);
  if (job.logFile) lines.push(`Log: ${job.logFile}`);

  // Show log tail if available
  if (job.logFile) {
    try {
      const log = fs.readFileSync(job.logFile, "utf8").trim();
      if (log) {
        const logLines = log.split("\n");
        const tail = logLines.slice(-15).join("\n");
        lines.push("", "--- Recent progress ---", tail);
      }
    } catch {}
  }

  console.log(lines.join("\n"));
}

function printJobTable(jobs) {
  const rows = jobs.map((j) => {
    const elapsed = j.startedAt
      ? j.completedAt
        ? formatDuration(new Date(j.completedAt) - new Date(j.startedAt))
        : formatDuration(Date.now() - new Date(j.startedAt))
      : "—";
    return {
      id: j.id,
      status: j.status,
      phase: j.phase ?? "—",
      elapsed,
      summary: j.summary ?? "—",
    };
  });

  // Simple table output
  console.log("| ID | Status | Phase | Elapsed | Summary |");
  console.log("|----|--------|-------|---------|---------|");
  for (const r of rows) {
    console.log(`| ${r.id} | ${r.status} | ${r.phase} | ${r.elapsed} | ${r.summary} |`);
  }
}

function formatDuration(ms) {
  if (!ms || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

// ---------------------------------------------------------------------------
// Result handler
// ---------------------------------------------------------------------------

async function handleResult(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: [],
    aliasMap: { C: "cwd" },
  });

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const workspaceRoot = getRepoRoot(cwd);
  const jobId = positionals[0] ?? null;

  if (!jobId) {
    // Find latest completed job in current session
    const sessionId = process.env.COPILOT_REVIEW_SESSION_ID || undefined;
    const jobs = listJobs(workspaceRoot, { sessionId });
    const completed = jobs.find((j) => j.status === "completed");
    if (!completed) {
      console.log("No completed review jobs found.");
      process.exitCode = 1;
      return;
    }
    const job = readStoredJob(workspaceRoot, completed.id);
    printJobResult(job ?? completed);
    return;
  }

  const job = safeReadJob(workspaceRoot, jobId);
  if (job === undefined) return; // invalid ID
  if (!job) {
    console.log(`Job not found: ${jobId}`);
    process.exitCode = 1;
    return;
  }
  printJobResult(job);
}

function printJobResult(job) {
  console.log(`Job: ${job.id}`);
  console.log(`Status: ${job.status}`);
  if (job.errorMessage) {
    console.log(`Error: ${job.errorMessage}`);
  }
  if (job.rendered) {
    console.log("");
    console.log(job.rendered);
  } else if (job.result) {
    console.log("");
    console.log(typeof job.result === "string" ? job.result : JSON.stringify(job.result, null, 2));
  } else if (isActiveJobStatus(job.status)) {
    console.log("\nJob is still running. Use `status <job-id> --wait` to wait for completion.");
  } else {
    console.log("\nNo result available.");
  }
}

// ---------------------------------------------------------------------------
// Cancel handler
// ---------------------------------------------------------------------------

async function handleCancel(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: [],
    aliasMap: { C: "cwd" },
  });

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const workspaceRoot = getRepoRoot(cwd);
  const jobId = positionals[0] ?? null;

  if (!jobId) {
    // Cancel latest active job in current session
    const sessionId = process.env.COPILOT_REVIEW_SESSION_ID || undefined;
    const jobs = listJobs(workspaceRoot, { sessionId });
    const active = jobs.find((j) => isActiveJobStatus(j.status));
    if (!active) {
      console.log("No active review jobs to cancel.");
      return;
    }
    await cancelJob(workspaceRoot, active.id);
    return;
  }

  await cancelJob(workspaceRoot, jobId);
}

async function cancelJob(workspaceRoot, jobId) {
  const job = safeReadJob(workspaceRoot, jobId);
  if (job === undefined) return; // invalid ID
  if (!job) {
    console.log(`Job not found: ${jobId}`);
    process.exitCode = 1;
    return;
  }

  if (!isActiveJobStatus(job.status)) {
    console.log(`Job ${jobId} is already ${job.status}.`);
    return;
  }

  // Kill the process
  const killed = terminateProcessTree(job.pid);

  // Re-read job after kill to avoid clobbering a completed result
  const current = readStoredJob(workspaceRoot, jobId) ?? job;
  if (!isActiveJobStatus(current.status)) {
    console.log(`Job ${jobId} completed (${current.status}) before cancel took effect.`);
    return;
  }

  // If kill failed and process may still be running, don't mark as cancelled
  if (!killed && current.pid) {
    // Check if process is actually still alive
    let alive = false;
    try { process.kill(current.pid, 0); alive = true; } catch {}
    if (alive) {
      console.log(`Failed to terminate process ${current.pid} for job ${jobId}. Job is still running.`);
      return;
    }
  }

  // Write cancelled state
  const completedAt = nowIso();
  writeJobFile(workspaceRoot, jobId, {
    ...current,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
  });
  upsertJob(workspaceRoot, {
    id: jobId,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
  });

  if (job.logFile) {
    appendLogLine(job.logFile, "Cancelled by user.");
  }

  console.log(`Cancelled job ${jobId}${killed ? " (process terminated)" : ""}.`);
}

// ---------------------------------------------------------------------------
// Task worker — runs in a detached child to execute a background review
// ---------------------------------------------------------------------------

async function handleTaskWorker(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "job-id"],
    booleanOptions: [],
  });

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const jobId = options["job-id"];
  if (!jobId) {
    process.stderr.write("task-worker: --job-id is required\n");
    process.exitCode = 1;
    return;
  }

  const workspaceRoot = getRepoRoot(cwd);
  let storedJob;
  try {
    storedJob = readStoredJob(workspaceRoot, jobId);
  } catch {
    process.stderr.write(`task-worker: invalid job ID "${jobId}"\n`);
    process.exitCode = 1;
    return;
  }
  if (!storedJob) {
    process.stderr.write(`task-worker: job ${jobId} not found\n`);
    process.exitCode = 1;
    return;
  }

  const request = storedJob.request;
  if (!request) {
    process.stderr.write(`task-worker: job ${jobId} has no stored request\n`);
    process.exitCode = 1;
    return;
  }

  // Check if job was cancelled before we start
  if (storedJob.status === "cancelled") {
    process.stderr.write(`task-worker: job ${jobId} was cancelled, skipping\n`);
    return;
  }

  const logFile = storedJob.logFile ?? createJobLogFile(workspaceRoot, jobId, "Copilot Review");
  appendLogLine(logFile, "Task worker started.");

  await runTrackedJob(
    { ...storedJob, workspaceRoot, logFile },
    async () => {
      // Re-check cancellation before expensive work
      const current = readStoredJob(workspaceRoot, jobId);
      if (current && current.status === "cancelled") {
        appendLogLine(logFile, "Job was cancelled before review started.");
        return { exitStatus: 0, payload: null, rendered: "Cancelled.", summary: "Cancelled" };
      }

      // Replay the review with --job-id and --json so errors are captured in stdout
      const reviewArgv = [...(request.argv ?? []), "--job-id", jobId, "--json"];

      // Capture the review output by temporarily redirecting stdout
      let reviewOutput = "";
      let reviewStderr = "";
      const origStdoutWrite = process.stdout.write.bind(process.stdout);
      const origStderrWrite = process.stderr.write.bind(process.stderr);
      process.stdout.write = (chunk) => { reviewOutput += chunk; return true; };
      const origStderr = process.stderr.write;
      process.stderr.write = (chunk) => {
        reviewStderr += chunk;
        return origStderrWrite(chunk);
      };

      try {
        await handleReview(reviewArgv);
      } finally {
        process.stdout.write = origStdoutWrite;
        process.stderr.write = origStderr;
      }

      // Parse the output — always JSON since we added --json
      let payload = null;
      let rendered = reviewOutput.trim();
      try {
        payload = JSON.parse(rendered);
        rendered = payload.review ?? rendered;
      } catch {
        payload = { review: rendered };
      }

      // If the review failed, capture error info
      const exitStatus = process.exitCode ?? 0;
      if (exitStatus !== 0 && !payload.error && reviewStderr) {
        payload.error = reviewStderr.trim().split("\n").pop();
      }

      return {
        exitStatus: process.exitCode ?? 0,
        payload,
        rendered,
        summary: storedJob.summary ?? "Review complete",
      };
    },
    { logFile }
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);

  switch (subcommand) {
    case "review":
      await handleReview(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      await handleResult(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    default: {
      const usage =
        `Usage: copilot-acp-companion.mjs <subcommand> [options]\n` +
        `\nSubcommands:\n` +
        `  review        Run a Copilot code review via ACP\n` +
        `  status        Show active and recent review jobs\n` +
        `  result        Show the full review output for a finished job\n` +
        `  cancel        Cancel a running review job\n` +
        `  task-worker   (internal) Run a background review task\n` +
        `\nOptions:\n` +
        `  --cwd <path>         Working directory (default: cwd)\n` +
        `  --base <ref>         Git base ref for diff (default: working tree)\n` +
        `  --json               Output structured JSON\n` +
        `  --stream             Stream Copilot response text to stderr\n` +
        `  --debug              Dump raw ACP protocol messages to stderr\n` +
        `  --background         Run review in background (returns job ID immediately)\n` +
        `  --timeout <ms>       Max wall-clock timeout in ms (default: 1800000 = 30 min)\n` +
        `  --idle-timeout <ms>  Idle timeout — cancel if no activity for this long (default: 120000 = 2 min)\n`;
      if (subcommand) {
        process.stderr.write(usage);
        process.exitCode = 1;
      } else {
        process.stdout.write(usage);
      }
    }
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exitCode = 1;
});
