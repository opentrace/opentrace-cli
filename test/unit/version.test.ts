import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { isNewerVersion, packageName, packageVersion } from "../../src/util/version.js"

describe("isNewerVersion", () => {
  it("offers a genuinely newer release", () => {
    assert.equal(isNewerVersion("0.5.0", "0.5.1"), true)
    assert.equal(isNewerVersion("0.5.0", "0.6.0"), true)
    assert.equal(isNewerVersion("0.5.0", "1.0.0"), true)
  })

  it("does not offer the same or an older release", () => {
    assert.equal(isNewerVersion("0.5.0", "0.5.0"), false)
    // The case that matters while main lags behind dev: a machine on the newer
    // build must not be told to "update" to what is published.
    assert.equal(isNewerVersion("0.5.1", "0.5.0"), false)
    assert.equal(isNewerVersion("1.0.0", "0.9.9"), false)
  })

  it("never offers a prerelease as an update", () => {
    assert.equal(isNewerVersion("0.5.0", "0.6.0-rc.1"), false)
    assert.equal(isNewerVersion("0.5.0", "1.0.0-beta"), false)
  })

  it("treats the released version as newer than its own prerelease", () => {
    assert.equal(isNewerVersion("0.5.0-rc.1", "0.5.0"), true)
  })

  it("tolerates short and malformed versions instead of throwing", () => {
    assert.equal(isNewerVersion("1.0", "1.0.1"), true)
    assert.equal(isNewerVersion("not-a-version", "1.0.0"), false)
    assert.equal(isNewerVersion("1.0.0", "also-not"), false)
  })

  it("compares numerically, not lexically", () => {
    // "10" < "9" as strings; the whole point of the comparison is that it isn't.
    assert.equal(isNewerVersion("0.9.0", "0.10.0"), true)
    assert.equal(isNewerVersion("0.10.0", "0.9.0"), false)
  })
})

describe("package manifest", () => {
  it("reads the real name and version", () => {
    assert.equal(packageName(), "@opentrace/cli")
    assert.match(packageVersion(), /^\d+\.\d+\.\d+/)
  })
})
