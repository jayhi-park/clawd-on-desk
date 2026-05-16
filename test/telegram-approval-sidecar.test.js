"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const test = require("node:test");

const {
  TelegramApprovalSidecar,
  parseHandshakeLine,
  buildSidecarEnv,
  resolveSidecarBinaryPath,
  defaultConfigPath,
  defaultTokenEnvFilePath,
  redactText,
  SIDECAR_ENV_CONFIG,
  SIDECAR_ENV_TOKEN_FILE,
  SIDECAR_ENV_TOKEN,
} = require("../src/telegram-approval-sidecar");

class FakeStream extends EventEmitter {
  setEncoding(value) {
    this.encoding = value;
  }
}

class FakeChild extends EventEmitter {
  constructor({ exitOnKill = true } = {}) {
    super();
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.killed = false;
    this.killCalls = [];
    this.exitOnKill = exitOnKill;
  }

  kill(signal) {
    this.killed = true;
    this.killCalls.push(signal);
    if (this.exitOnKill) {
      queueMicrotask(() => this.emit("exit", null, signal || "SIGTERM"));
    }
    return true;
  }

  emitHandshake(port = 34567, token = "a".repeat(64)) {
    this.stdout.emit("data", `SIDECAR_LISTEN=127.0.0.1:${port} SIDECAR_TOKEN=${token}\n`);
  }
}

function makeSpawn(children) {
  const calls = [];
  const spawn = (bin, args, opts) => {
    const child = children.length ? children.shift() : new FakeChild();
    calls.push({ bin, args, opts, child });
    return child;
  };
  return { spawn, calls };
}

test("parseHandshakeLine accepts only local sidecar handshakes", () => {
  assert.deepEqual(parseHandshakeLine(`SIDECAR_LISTEN=127.0.0.1:23333 SIDECAR_TOKEN=${"f".repeat(64)}`), {
    listen: "127.0.0.1:23333",
    token: "f".repeat(64),
  });
  assert.equal(parseHandshakeLine(`SIDECAR_LISTEN=0.0.0.0:23333 SIDECAR_TOKEN=${"f".repeat(64)}`), null);
  assert.equal(parseHandshakeLine("hello"), null);
  assert.equal(parseHandshakeLine(`SIDECAR_LISTEN=127.0.0.1:70000 SIDECAR_TOKEN=${"f".repeat(64)}`), null);
});

test("buildSidecarEnv uses an allowlist and does not inherit unrelated secrets", () => {
  const env = buildSidecarEnv({
    platform: "win32",
    baseEnv: {
      PATH: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      OPENAI_API_KEY: "sk-should-not-inherit",
      RANDOM_SECRET: "nope",
    },
    configPath: "C:\\Users\\me\\AppData\\Roaming\\Clawd on Desk\\cc-connect-clawd\\clawd-bridge.toml",
    tokenEnvFilePath: "C:\\Users\\me\\AppData\\Roaming\\Clawd on Desk\\telegram-approval.env",
  });
  assert.equal(env.PATH, "C:\\Windows");
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.RANDOM_SECRET, undefined);
  assert.equal(env[SIDECAR_ENV_CONFIG].endsWith("clawd-bridge.toml"), true);
  assert.equal(env[SIDECAR_ENV_TOKEN_FILE].endsWith("telegram-approval.env"), true);
  assert.equal(env[SIDECAR_ENV_TOKEN], undefined);
});

test("sidecar manager parses handshake and creates a client", async () => {
  const child = new FakeChild();
  const { spawn, calls } = makeSpawn([child]);
  const sidecar = new TelegramApprovalSidecar({
    spawn,
    binaryPath: "D:\\tmp\\cc-connect-clawd\\cc-connect-clawd.exe",
    userDataDir: "C:\\Users\\me\\AppData\\Roaming\\Clawd on Desk",
    baseEnv: { PATH: "C:\\Windows", OPENAI_API_KEY: "sk-nope" },
    startupTimeoutMs: 100,
  });

  const ready = sidecar.start();
  child.emitHandshake(24444, "b".repeat(64));
  const client = await ready;

  assert.equal(sidecar.getStatus().status, "running");
  assert.equal(sidecar.getStatus().listen, "127.0.0.1:24444");
  assert.equal(client.isEnabled(), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    "--config",
    defaultConfigPath("C:\\Users\\me\\AppData\\Roaming\\Clawd on Desk"),
    "--env-file",
    defaultTokenEnvFilePath("C:\\Users\\me\\AppData\\Roaming\\Clawd on Desk"),
  ]);
  assert.equal(calls[0].opts.env.OPENAI_API_KEY, undefined);
});

test("sidecar manager times out malformed startup and kills child", async () => {
  const child = new FakeChild({ exitOnKill: false });
  const { spawn } = makeSpawn([child]);
  const sidecar = new TelegramApprovalSidecar({
    spawn,
    binaryPath: "sidecar.exe",
    startupTimeoutMs: 10,
    autoRestart: false,
  });

  const promise = sidecar.start();
  child.stdout.emit("data", "not a handshake\n");
  await assert.rejects(promise, /timed out/);
  assert.equal(child.killed, true);
  assert.equal(sidecar.getStatus().status, "failed");
});

test("sidecar manager redacts stderr before logging", async () => {
  const child = new FakeChild();
  const logs = [];
  const { spawn } = makeSpawn([child]);
  const sidecar = new TelegramApprovalSidecar({
    spawn,
    binaryPath: "sidecar.exe",
    redactionSecrets: ["telegram:123456789", "987654321"],
    log: (level, message, meta) => logs.push({ level, message, meta }),
  });

  const ready = sidecar.start();
  child.stderr.emit("data", "failed for telegram:123456789 user 987654321 token=123:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi");
  child.emitHandshake();
  await ready;

  const text = logs.map((entry) => entry.meta && entry.meta.text).join("\n");
  assert.equal(text.includes("telegram:123456789"), false);
  assert.equal(text.includes("987654321"), false);
  assert.equal(text.includes("123:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi"), false);
});

test("sidecar manager stop terminates child and marks stopped", async () => {
  const child = new FakeChild();
  const { spawn } = makeSpawn([child]);
  const sidecar = new TelegramApprovalSidecar({ spawn, binaryPath: "sidecar.exe" });
  const ready = sidecar.start();
  child.emitHandshake();
  await ready;

  await sidecar.stop();
  assert.equal(child.killCalls[0], "SIGTERM");
  assert.equal(sidecar.getStatus().status, "stopped");
});

test("sidecar manager restarts unexpected exits with a rate limit", async () => {
  const first = new FakeChild();
  const second = new FakeChild();
  const third = new FakeChild();
  const { spawn, calls } = makeSpawn([first, second, third]);
  const sidecar = new TelegramApprovalSidecar({
    spawn,
    binaryPath: "sidecar.exe",
    restartBackoffMs: 1,
    restartLimit: 1,
    restartWindowMs: 60000,
  });

  const firstReady = sidecar.start();
  first.emitHandshake(20001);
  await firstReady;
  first.emit("exit", 1, null);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls.length, 2);

  const secondReady = sidecar.start();
  second.emitHandshake(20002);
  await secondReady;
  second.emit("exit", 1, null);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls.length, 2, "restart rate limit should block a third spawn");
  assert.equal(sidecar.getStatus().status, "failed");
  assert.match(sidecar.getStatus().message, /rate limit/);
});

test("resolveSidecarBinaryPath honors explicit and env paths", () => {
  assert.equal(resolveSidecarBinaryPath({ binaryPath: "explicit.exe" }), "explicit.exe");
  assert.equal(resolveSidecarBinaryPath({
    env: { CLAWD_CC_CONNECT_CLAWD_PATH: "env.exe" },
  }), "env.exe");
  assert.equal(resolveSidecarBinaryPath({
    resourcesPath: "C:\\resources",
    platform: "win32",
  }), path.join("C:\\resources", "cc-connect-clawd.exe"));
});

test("redactText masks known Telegram identifiers and token-like values", () => {
  const redacted = redactText("chat telegram:123456789 user 987654321 bot 123:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi", [
    "telegram:123456789",
  ]);
  assert.equal(redacted.includes("telegram:123456789"), false);
  assert.equal(redacted.includes("987654321"), false);
  assert.equal(redacted.includes("123:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi"), false);
});
