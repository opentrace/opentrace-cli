// Runs the compiled test suite.
//
// A wrapper rather than a bare `node --test …` in package.json, for two reasons
// that both bit us:
//
//   1. There is no portable way to point `--test` at a set of files. Node 22
//      treats its arguments as glob patterns and will not expand a directory;
//      Node 18 has no glob support at all and needs literal paths. Shell globs
//      cover both but not Windows. Enumerating here works everywhere.
//
//   2. `--test-force-exit` is the difference between a red build and a hung one.
//      On macOS CI the runner reported every test passing and then sat with an
//      open handle for ten minutes until the job timed out — twice, leaving
//      orphan node processes behind. This flag makes the runner exit once results
//      are in, which is what we actually want from a test run. It landed in Node
//      20.14, so it is applied only where it exists; the Node 18 job (which only
//      exists to prove the engines floor) runs without it.

import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const ROOT = new URL("..", import.meta.url).pathname
const SUITES = process.argv.slice(2)
const groups = SUITES.length > 0 ? SUITES : ["unit", "integration"]

/** Compiled *.test.js under build-test/test/<group>, recursively. */
function testFiles(group) {
  const base = path.join(ROOT, "build-test", "test", group)
  if (!fs.existsSync(base)) return []
  const found = []
  for (const entry of fs.readdirSync(base, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".test.js")) {
      found.push(path.join(entry.parentPath ?? entry.path ?? base, entry.name))
    }
  }
  return found.sort()
}

const files = groups.flatMap(testFiles)
if (files.length === 0) {
  console.error(`No compiled tests found for: ${groups.join(", ")}. Run the build first.`)
  process.exit(1)
}

const [major, minor] = process.versions.node.split(".").map(Number)
const supportsForceExit = major > 20 || (major === 20 && minor >= 14)

const args = ["--test"]
if (supportsForceExit) args.push("--test-force-exit")
args.push(...files)

const child = spawn(process.execPath, args, { stdio: "inherit", cwd: ROOT })
child.on("close", (code, signal) => {
  if (signal) {
    console.error(`Test runner terminated by ${signal}.`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
