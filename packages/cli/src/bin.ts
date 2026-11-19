#!/usr/bin/env node
import { CommanderError, createProgram, defaultBuildConnectors } from "./program.js";

const program = createProgram({
  buildConnectors: defaultBuildConnectors,
  now: () => new Date(),
  write: (text) => process.stdout.write(text),
  env: process.env,
  isTTY: Boolean(process.stdout.isTTY),
});

program.parseAsync(process.argv).catch((error: unknown) => {
  // Commander has already printed usage errors, --help and --version output.
  if (error instanceof CommanderError) process.exit(error.exitCode);
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
