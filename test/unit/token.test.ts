import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { looksLikeToken, maskToken, TOKEN_REGEX, validateTokenShape } from "../../src/util/token.js"
import { otk } from "../stub-server.js"

describe("token shape", () => {
  it("accepts otk_ plus exactly 43 URL-safe characters", () => {
    const good = otk("a")
    assert.equal(good.length, 47)
    assert.ok(TOKEN_REGEX.test(good))
    assert.equal(validateTokenShape(good), null)
  })

  it("rejects a wrong prefix with a message naming the prefix", () => {
    const error = validateTokenShape(`sk_${"a".repeat(43)}`)
    assert.match(String(error), /must start with "otk_"/)
  })

  it("rejects a wrong length with a message naming both lengths", () => {
    const error = validateTokenShape("otk_tooshort")
    assert.match(String(error), /43 URL-safe characters/)
    assert.match(String(error), /got 12 chars total, expected 47/)
  })

  it("rejects characters outside the URL-safe alphabet", () => {
    assert.notEqual(validateTokenShape(`otk_${"a".repeat(42)}+`), null)
    assert.notEqual(validateTokenShape(`otk_${"a".repeat(42)}/`), null)
  })

  it("recognises a token argument by prefix alone, for the connect overload", () => {
    // Deliberately looser than the shape check: `connect` must route a
    // malformed key to the key branch so it gets a shape error, not a
    // "directory not found" from the path branch.
    assert.equal(looksLikeToken("otk_whatever"), true)
    assert.equal(looksLikeToken("./some/path"), false)
    assert.equal(looksLikeToken("."), false)
  })
})

describe("maskToken", () => {
  it("keeps a recognisable head and tail but never the middle", () => {
    const token = otk("secret")
    const masked = maskToken(token)
    assert.ok(masked.startsWith("otk_"))
    assert.ok(!masked.includes(token.slice(8, -4)))
    assert.ok(masked.includes("…"))
  })

  it("does not leak a short string by showing all of it", () => {
    assert.equal(maskToken("otk_abc"), "otk_…")
  })
})
