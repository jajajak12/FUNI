"use strict";

const fs = require("node:fs");
const { homedir } = require("node:os");
const { resolve } = require("node:path");

const explicitGmgnApiKey = Object.hasOwn(process.env, "GMGN_API_KEY") && process.env.GMGN_API_KEY
  ? process.env.GMGN_API_KEY
  : undefined;

if (explicitGmgnApiKey !== undefined) {
  const globalGmgnEnvPath = resolve(homedir(), ".config", "gmgn", ".env");
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function gmgnCredentialPrecedenceReadFileSync(path, ...args) {
    const value = originalReadFileSync.call(this, path, ...args);
    let resolvedPath;
    try { resolvedPath = resolve(String(path)); } catch { return value; }
    if (resolvedPath !== globalGmgnEnvPath) return value;
    const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
    const filtered = text.replace(/^\s*(?:export\s+)?GMGN_API_KEY\s*=.*(?:\r?\n|$)/gm, "");
    return Buffer.isBuffer(value) ? Buffer.from(filtered, "utf8") : filtered;
  };
}
