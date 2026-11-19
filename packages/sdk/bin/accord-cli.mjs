#!/usr/bin/env node
import { runCli } from "../dist/esm/cli.js";

const result = await runCli(process.argv.slice(2));
console.log(result.output);
if (!result.success) {
  process.exit(1);
}
