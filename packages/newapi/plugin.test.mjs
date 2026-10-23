import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"

import { _internal, NewapiPlugin, NewapiSite1 } from "./index.mjs"
import { makeServer, listen, RELAY_KEY, USER } from "./mock-server.mjs"

// A fake magpie account store: the plugin's client.auth.set writes here, and a
// getAuth helper reads the current account back, exactly as magpie scopes it.
function store(initial = {}) {
  let current = initial
  return {
    client: { auth: { set: async ({ body }) => { current = body } } },
    getAuth: async () => current,
    peek: () => current,
  }
}

let base, server
before(async () => {
  ;({ server } = makeServer())
  base = await listen(server)
})
after(() => server.close())

describe("helpers", () => {
  it("root strips a trailing /v1 and slashes", () => {
    assert.equal(_internal.root("https://x.com/v1/"), "https://x.com")
    assert.equal(_internal.root("https://x.com///"), "https://x.com")
    assert.equal(_internal.root(" https://x.com "), "https://x.com")
  })

  it("checkURL accepts http(s) only", () => {
    assert.equal(_internal.checkURL("ftp://x"), "The address starts with https://")
    assert.equal(_internal.checkURL("nonsense"), "An address such as https://api.example.com")
    assert.equal(_internal.checkURL("https://x.com"), undefined)
  })

  it("npmOf picks the AI SDK package by model id", () => {
    assert.equal(_internal.npmOf("claude-3-5-sonnet"), "@ai-sdk/anthropic")
    assert.equal(_internal.npmOf("gpt-4o"), "@ai-sdk/openai")
    assert.equal(_internal.npmOf("o3-mini"), "@ai-sdk/openai")
    assert.equal(_internal.npmOf("deepseek-chat"), "@ai-sdk/openai-compatible")
  })

  it("runtimeModel marks a reasoning model and fills variants", () => {
    const m = _internal.runtimeModel({ id: "deepseek-r1", name: "R1" }, "https://x/v1", "newapi")
    assert.equal(m.api.npm, "@ai-sdk/openai-compatible")
    assert.equal(m.capabilities.reasoning, true)
    assert.deepEqual(Object.keys(m.variants), ["low", "medium", "high"])
  })

  it("npmFor follows the relay's endpoint hint over the name", () => {
    assert.equal(_internal.npmFor({ id: "claude-x", endpoints: ["openai"] }), "@ai-sdk/openai-compatible")
    assert.equal(_internal.npmFor({ id: "gpt-5-codex", endpoints: ["openai-response"] }), "@ai-sdk/openai")
    assert.equal(_internal.npmFor({ id: "claude-3-5-sonnet" }), "@ai-sdk/anthropic")
    assert.equal(_internal.isChatModel({ id: "x", endpoints: ["embeddings"] }), false)
    assert.equal(_internal.isChatModel({ id: "x" }), true)
  })

  it("balanceTokenOf reads only a non-empty metadata.balanceToken", () => {
    assert.equal(_internal.balanceTokenOf({ metadata: {} }), "")
    assert.equal(_internal.balanceTokenOf({ metadata: { balanceToken: "  " } }), "")
    assert.equal(_internal.balanceTokenOf({ metadata: { balanceToken: " nap_x " } }), "nap_x")
  })
})

describe("models hook", () => {
  it("lists and classifies the relay key's models", async () => {
    const h = await NewapiPlugin(store())
    const got = await h.provider.models({ models: {} }, { auth: { type: "api", key: RELAY_KEY, metadata: { baseURL: base } } })
    // embeddings-only model is dropped; the rest keep their endpoint hint
    assert.deepEqual(Object.keys(got).sort(), ["claude-3-5-sonnet", "deepseek-chat", "gpt-4o"])
    assert.equal(got["claude-3-5-sonnet"].api.npm, "@ai-sdk/anthropic")
    assert.equal(got["gpt-4o"].api.npm, "@ai-sdk/openai")
    assert.equal(got["deepseek-chat"].api.npm, "@ai-sdk/openai-compatible")
  })

  it("marks a refused relay key as signIn expired", async () => {
    const h = await NewapiPlugin(store())
    await assert.rejects(
      () => h.provider.models({ models: {} }, { auth: { type: "api", key: "sk-bad", metadata: { baseURL: base } } }),
      (e) => e.signIn === "expired",
    )
  })

  it("falls back to provider.models when the site is unreachable", async () => {
    const h = await NewapiPlugin(store())
    const was = { keep: { id: "keep" } }
    const got = await h.provider.models({ models: was }, { auth: { type: "api", key: RELAY_KEY, metadata: { baseURL: "http://127.0.0.1:1" } } })
    assert.deepEqual(got, was)
  })
})

describe("usage hook", () => {
  it("reads balance + subscription when an access token is saved", async () => {
    const s = store({ type: "api", key: RELAY_KEY, accountId: "acct", metadata: { baseURL: base, balanceToken: "dash-x", name: "acct" } })
    const h = await NewapiPlugin(s)
    const u = await h.auth.usage(s.getAuth)
    assert.equal(u.error, undefined)
    assert.equal(u.user, "ada")
    assert.equal(u.plan, "Pro Plan")
    assert.equal(u.balance, "$12.40")
    const win = u.windows.find((w) => w.name === "Pro Plan")
    assert.ok(win)
    assert.equal(win.display, "$2.50 / $10.00")
    assert.equal(win.used, 25)
  })

  it("shows only the user name when no access token is saved", async () => {
    const s = store({ type: "api", key: RELAY_KEY, metadata: { baseURL: base, name: "relay" } })
    const h = await NewapiPlugin(s)
    const u = await h.auth.usage(s.getAuth)
    assert.deepEqual(u, { user: "relay" })
  })

  it("surfaces a bad access token as an error, without leaking it", async () => {
    const s = store({ type: "api", key: RELAY_KEY, metadata: { baseURL: base, balanceToken: "wrong-token", name: "acct" } })
    const h = await NewapiPlugin(s)
    const u = await h.auth.usage(s.getAuth)
    assert.ok(u.error)
    assert.ok(!String(u.error).includes("wrong-token"))
  })
})

describe("sign-in (oauth auto callback)", () => {
  async function signIn(inputs) {
    const h = await NewapiPlugin(store())
    const m = h.auth.methods[0]
    const flow = await m.authorize(inputs)
    return flow.callback()
  }

  it("asks baseURL, apiKey, accessToken, userId and saves the api key", async () => {
    const h = await NewapiPlugin(store())
    const keys = h.auth.methods[0].prompts.map((p) => p.key)
    assert.deepEqual(keys, ["baseURL", "apiKey", "accessToken", "userId"])

    const r = await signIn({ baseURL: base, apiKey: RELAY_KEY, accessToken: "dash-x" })
    assert.equal(r.type, "success")
    assert.equal(r.key, RELAY_KEY)
    assert.equal(r.metadata.balanceToken, "dash-x")
  })

  it("refuses a bad api key before saving", async () => {
    const r = await signIn({ baseURL: base, apiKey: "sk-bad" })
    assert.equal(r.type, "failed")
    assert.match(r.error, /API key/)
  })

  it("refuses a bad access token before saving", async () => {
    const r = await signIn({ baseURL: base, apiKey: RELAY_KEY, accessToken: "bad-token" })
    assert.equal(r.type, "failed")
    assert.match(r.error, /access token/)
  })

  it("accepts a key with no access token", async () => {
    const r = await signIn({ baseURL: base, apiKey: RELAY_KEY })
    assert.equal(r.type, "success")
    assert.equal(r.metadata.balanceToken, undefined)
  })
})

describe("balance-only sites", () => {
  it("reports balance and no window (no fake 100% bar)", async () => {
    const { server: s2 } = makeServer({ noSubs: true })
    const b2 = await listen(s2)
    try {
      const s = store({ type: "api", key: RELAY_KEY, metadata: { baseURL: b2, balanceToken: "dash-x" } })
      const h = await NewapiPlugin(s)
      const u = await h.auth.usage(s.getAuth)
      assert.equal(u.balance, "$12.40")
      assert.deepEqual(u.windows, [])
      assert.equal(u.plan, "default")
    } finally {
      s2.close()
    }
  })
})

describe("sites as named providers with model combinations", () => {
  it("parses id/name/url and model filters", () => {
    const sites = _internal.sitesOf(
      {
        sites: [
          { id: "gap-claude", name: "GAP-Claude", url: "https://x.com", models: ["claude-*"] },
          { id: "gap-codex", name: "GAP-Codex", url: "https://x.com", exclude: ["/image/"] },
        ],
      },
      false,
    )
    assert.deepEqual(sites.map((s) => s.id), ["gap-claude", "gap-codex"])
    assert.deepEqual(sites[0].models, ["claude-*"])
    assert.deepEqual(sites[1].exclude, ["/image/"])
  })

  it("modelAllowed honours exact ids, prefixes and /regex/", () => {
    assert.equal(_internal.modelAllowed("claude-opus-5", ["claude-*"]), true)
    assert.equal(_internal.modelAllowed("gpt-6-sol", ["claude-*"]), false)
    assert.equal(_internal.modelAllowed("gpt-image-2", [], ["/image/"]), false)
    assert.equal(_internal.modelAllowed("gpt-6-sol", [], ["/image/"]), true)
    assert.equal(_internal.modelAllowed("gpt-6-sol", ["gpt-6-sol"], []), true)
    assert.equal(_internal.modelAllowed("gpt-6-sol", ["gpt-5"], []), false)
  })

  it("each site provider lists only its own models", async () => {
    const { server: s2 } = makeServer()
    const b2 = await listen(s2)
    try {
      const h = await NewapiSite1(store(), { sites: [{ id: "claude-only", name: "Claude Only", url: b2, models: ["claude-*"] }] })
      const got = await h.provider.models({ models: {} }, { auth: { type: "api", key: RELAY_KEY, metadata: { baseURL: b2 } } })
      assert.deepEqual(Object.keys(got), ["claude-3-5-sonnet"])
      assert.equal(h.auth.provider, "claude-only")
    } finally {
      s2.close()
    }
  })
})

describe("named model-combination providers (site without url)", () => {
  it("accepts a site with an id but no url", () => {
    const sites = _internal.sitesOf({ sites: [{ id: "claude-pool", name: "Claude Pool", models: ["claude-*"] }] }, false)
    assert.equal(sites.length, 1)
    assert.equal(sites[0].id, "claude-pool")
    assert.equal(sites[0].base, undefined)
    assert.deepEqual(sites[0].models, ["claude-*"])
  })

  it("asks for the address at sign-in and saves it", async () => {
    const h = await NewapiSite1(store(), { sites: [{ id: "claude-pool", name: "Claude Pool", models: ["claude-*"] }] })
    assert.deepEqual(h.auth.methods[0].prompts.map((p) => p.key), ["baseURL", "apiKey", "accessToken", "userId"])
    const flow = await h.auth.methods[0].authorize({ baseURL: base, apiKey: RELAY_KEY })
    const r = await flow.callback()
    assert.equal(r.type, "success")
    assert.equal(r.metadata.baseURL, base)
  })

  it("still filters the provider's models", async () => {
    const { server: s2 } = makeServer()
    const b2 = await listen(s2)
    try {
      const h = await NewapiSite1(store(), { sites: [{ id: "claude-pool", name: "Claude Pool", url: b2, models: ["claude-*"] }] })
      const got = await h.provider.models({ models: {} }, { auth: { type: "api", key: RELAY_KEY, metadata: { baseURL: b2 } } })
      assert.deepEqual(Object.keys(got), ["claude-3-5-sonnet"])
    } finally {
      s2.close()
    }
  })
})

describe("account model", () => {
  it("one account = baseURL + apiKey; access token only adds balance", async () => {
    // the relay key serves; the access token is separate from it
    const s = store({ type: "api", key: RELAY_KEY, metadata: { baseURL: base, balanceToken: "dash-x", name: "AICode" } })
    const h = await NewapiPlugin(s)
    const got = await h.provider.models({ models: {} }, { auth: s.peek() })
    assert.ok(Object.keys(got).length)
    const u = await h.auth.usage(s.getAuth)
    assert.equal(u.balance, "$12.40")
    // auth.key is never overwritten by the access token
    assert.equal(s.peek().key, RELAY_KEY)
  })

  it("each exported function returns a provider (community check)", async () => {
    const h = await NewapiSite1(store(), { sites: [{ id: "myrelay", name: "My Relay", url: base }] })
    assert.equal(h.auth.provider, "myrelay")
    // an unconfigured slot offers the first provider rather than nothing, so
    // magpie's check sees an auth hook everywhere; magpie merges by id
    const empty = await NewapiSite1(store(), { sites: [] })
    assert.equal(empty.auth.provider, _internal.ID)
    assert.ok(Array.isArray(empty.auth.methods) && empty.auth.methods.length)
  })
})
