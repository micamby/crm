#!/usr/bin/env node
import { run } from "./program.js";
import { terminalRuntime } from "./terminal.js";

process.exitCode = await run(process.argv.slice(2),
  terminalRuntime({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() }));
