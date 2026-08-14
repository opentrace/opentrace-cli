// `otx login` is interactive by design — it opens a browser and waits — so most
// of it cannot be driven from a piped child process. What IS testable headlessly
// is the guard that makes that refusal explicit rather than a hang, which is the
// behaviour automation actually depends on.
//
// Coverage gap, stated rather than hidden: the "-y keeps a still-valid key"
// branch needs a pseudo-terminal, because isInteractive() requires one on both
// stdin and stdout. It is verified by hand against test/stub-server.ts (see the
// Testing section of the README); a pty tier would automate it.

import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import { createSandbox, type Sandbox } from "../harness.js"
import { otk } from "../stub-server.js"

let sb: Sandbox

beforeEach(async () => {
  sb = await createSandbox()
})
afterEach(() => sb.cleanup())

describe("login without a terminal", () => {
  it("refuses rather than hanging, and points at the key flow", async () => {
    const r = await sb.run(["login", "--url", sb.stub.url])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /otx login is interactive/)
    assert.match(r.stderr, /otx connect otk_…/)
  })

  it("refuses before touching the network or any config", async () => {
    sb.seedPluginToken(otk("cli"))
    const r = await sb.run(["login", "--url", sb.stub.url, "-y"])
    assert.equal(r.code, 1)
    assert.equal(sb.apiRequests().length, 0, "no probe, no discovery, nothing")
    // And it certainly must not have replaced the key it found.
    assert.equal(sb.readSettings("user").enabledPlugins, undefined)
  })
})
