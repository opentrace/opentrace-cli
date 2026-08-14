// The verdict cache. Its one job beyond caching is to stop a stale verdict
// outliving the key it was about — which is what makes "your key was rejected"
// disappear on its own once the key is replaced.

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import { otk } from "../stub-server.js"

let home: string
let previousHome: string | undefined

// notice-state resolves its path from os.homedir() at call time, so pointing
// HOME at a temp dir is enough to isolate it.
beforeEach(() => {
  previousHome = process.env.HOME
  home = fs.mkdtempSync(path.join(os.tmpdir(), "otx-state-"))
  process.env.HOME = home
})
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  fs.rmSync(home, { recursive: true, force: true })
})

/** Imported per test so each picks up the current HOME. */
async function load() {
  return import(`../../src/util/notice-state.js?${Math.random()}`)
}

describe("notice state", () => {
  it("starts empty rather than throwing when nothing is cached", async () => {
    const m = await load()
    assert.deepEqual(m.readNoticeState(), {})
    assert.equal(m.readKeyVerdict(m.cliKeyId("https://h.test/mcp/v1/"), otk("a")), undefined)
  })

  it("round-trips a verdict for the key it was about", async () => {
    const m = await load()
    const id = m.cliKeyId("https://h.test/mcp/v1/")
    m.recordKeyVerdict(id, otk("a"), "rejected")
    assert.equal(m.readKeyVerdict(id, otk("a"))?.verdict, "rejected")
  })

  it("does not apply a verdict to a different key", async () => {
    const m = await load()
    const id = m.cliKeyId("https://h.test/mcp/v1/")
    m.recordKeyVerdict(id, otk("old"), "rejected")
    // Replace the key: the old verdict describes something no longer in use.
    assert.equal(m.readKeyVerdict(id, otk("new")), undefined)
  })

  it("scopes verdicts by endpoint and by settings file", async () => {
    const m = await load()
    m.recordKeyVerdict(m.cliKeyId("https://a.test/mcp/v1/"), otk("k"), "rejected")
    assert.equal(m.readKeyVerdict(m.cliKeyId("https://b.test/mcp/v1/"), otk("k")), undefined)
    assert.notEqual(m.usageKeyId("/a/settings.json"), m.usageKeyId("/b/settings.json"))
  })

  it("never writes the key itself to disk", async () => {
    const m = await load()
    m.recordKeyVerdict(m.cliKeyId("https://h.test/mcp/v1/"), otk("supersecret"), "valid")
    const raw = fs.readFileSync(m.noticeStatePath(), "utf8")
    assert.ok(!raw.includes(otk("supersecret")))
    assert.ok(raw.includes("fingerprint"))
  })

  it("keeps independent fields from clobbering each other", async () => {
    const m = await load()
    m.updateNoticeState((s: Record<string, unknown>) => {
      s.updateCheckedAt = 123
      s.latestVersion = "9.9.9"
    })
    m.recordKeyVerdict(m.cliKeyId("https://h.test/mcp/v1/"), otk("k"), "valid")
    const state = m.readNoticeState()
    assert.equal(state.latestVersion, "9.9.9")
    assert.equal(state.updateCheckedAt, 123)
    assert.ok(state.verdicts)
  })

  it("survives an unreadable cache instead of failing the command", async () => {
    const m = await load()
    fs.mkdirSync(path.dirname(m.noticeStatePath()), { recursive: true })
    fs.writeFileSync(m.noticeStatePath(), "{ not json", "utf8")
    assert.deepEqual(m.readNoticeState(), {})
    // And a write still repairs it.
    m.recordKeyVerdict(m.cliKeyId("https://h.test/mcp/v1/"), otk("k"), "valid")
    assert.equal(m.readKeyVerdict(m.cliKeyId("https://h.test/mcp/v1/"), otk("k"))?.verdict, "valid")
  })
})
