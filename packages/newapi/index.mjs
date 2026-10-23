// magpie-newapi: any New API / One API relay site as a magpie provider.
//
// New API (github.com/QuantumNous/new-api, and the One API family it grew
// from) speaks the OpenAI protocol on its relay endpoints and keeps a
// dashboard API that reports a user's wallet balance and subscription amounts.
// This plugin turns the site's relay keys into provider accounts, and reads
// each account's balance / subscription through the site's dashboard.
//
// Three things the rest of magpie needs:
//   - config:  declares the provider (models come from the accounts)
//   - auth:    one sign-in = one instance (base URL + relay key). The account's
//              dashboard login (username/password or an access token) is
//              optional and only feeds balance / subscription.
//   - usage:   the wallet balance and the active subscriptions' remaining amount
//
// Every sign-in pools under the one "newapi" provider, so several instances
// (keys on one site, or keys on several sites) jointly serve the same model
// family and magpie routes across them. If you would rather group keys by
// site, list the sites in the plugin's options; each site then becomes its own
// provider, and the keys signed into it are its accounts.
//
// New API's own public endpoints are used:
//   relay (the account's key):
//     GET  /v1/models
//     POST /v1/chat/completions · /v1/messages · /v1/responses
//   dashboard (username+password login, or a system access token):
//     GET  /api/status
//     GET  /api/user/login/encryption-key
//     POST /api/user/login
//     GET  /api/user/self
//     GET  /api/subscription/self
//     GET  /api/subscription/plans
//     GET  /api/token/           (the account's keys, masked)
//     POST /api/token/:id/key    (a key's full value)
//
// Every function this module exports is called as a plugin by magpie, so only
// the plugins (and the test-only _internal) are exported.

import { createPublicKey, constants as cryptoConstants, publicEncrypt } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const ID = "newapi"
const SLOTS = 6
const CHAT = "@ai-sdk/openai-compatible"
const MESSAGES = "@ai-sdk/anthropic"
const RESPONSES = "@ai-sdk/openai"
const TIMEOUT = 15_000
const DAY = 24 * 3600

// =============================================================================
// the site
// =============================================================================

// root is the site's address as typed, without a trailing slash and without a
// trailing /v1 that an OpenAI client's base URL would carry.
function root(url) {
  return String(url ?? "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "")
}

function checkURL(value) {
  try {
    const u = new URL(root(value))
    if (u.protocol !== "https:" && u.protocol !== "http:") return "The address starts with https://"
  } catch {
    return "An address such as https://api.example.com"
  }
}

function hostOf(base) {
  try {
    return new URL(base).host
  } catch {
    return base
  }
}

// balanceTokenOf is the optional system access token that only reads the
// dashboard (balance / subscription). The account's serving secret is always
// auth.key, a relay API key.
function balanceTokenOf(auth) {
  const t = auth?.metadata?.balanceToken
  return typeof t === "string" && t.trim() ? t.trim() : ""
}

// label is how magpie names the account: the name given at sign-in, else the
// key's name, else the site's host and the end of the relay key. It never shows
// a password or an access token.
function label(auth, base) {
  const md = auth?.metadata ?? {}
  const given = typeof md.name === "string" ? md.name.trim().slice(0, 60) : ""
  if (given) return given
  const key = typeof auth?.key === "string" ? auth.key : ""
  const tail = key.length >= 8 ? " …" + key.slice(-4) : ""
  return base ? hostOf(base) + tail : tail.trim()
}

// named saves the label on the account, where magpie reads an account's name
// (accountId). magpie's api sign-in keeps only {type, key, metadata}, so the
// name is written the first time the account is used, in its own scope.
async function named(client, id, auth, base) {
  const name = label(auth, base)
  if (!name || auth.accountId === name || typeof client?.auth?.set !== "function") return
  try {
    await client.auth.set({ path: { id }, body: { ...auth, accountId: name } })
  } catch {}
}

// saveAuth writes the account back whole (client.auth.set replaces it), so the
// secret and metadata are always carried over.
async function saveAuth(client, id, auth) {
  if (typeof client?.auth?.set !== "function") return
  try {
    await client.auth.set({ path: { id }, body: auth })
  } catch {}
}

// httpJson is one JSON request. A non-2xx reply becomes an Error carrying the
// site's own message; a 401 that means the credential was refused gets
// signIn = "expired" when markSignIn is set.
async function httpJson(base, path, { token, userId, body, method = "GET", headers = {}, markSignIn = true } = {}) {
  const h = { Accept: "application/json", ...headers }
  if (token) h.Authorization = `Bearer ${token}`
  // some New API builds also want the numeric owner id of the token
  if (userId !== undefined && userId !== null && String(userId).trim() !== "") h["New-Api-User"] = String(userId)
  let payload
  if (body !== undefined) {
    h["Content-Type"] = "application/json"
    payload = JSON.stringify(body)
  }
  const res = await fetch(base + path, { method, headers: h, body: payload, signal: AbortSignal.timeout(TIMEOUT) })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {}
  if (!res.ok) {
    const why = data?.error?.message ?? data?.message ?? data?.error ?? (text.trim().slice(0, 200) || res.statusText)
    const err = new Error(`${res.status} ${why}`)
    if (markSignIn && res.status === 401) err.signIn = "expired"
    throw err
  }
  if (data === undefined) throw new Error(`${path}: not JSON`)
  // New API's envelope is {success, message, data}; success:false is an error
  // even with a 200 status.
  if (data && data.success === false) {
    const why = data.message || data.error?.message || "request refused"
    const err = new Error(why)
    if (markSignIn && /token|unauthor|expired|login|密码|令牌|登录/i.test(why)) err.signIn = "expired"
    throw err
  }
  return data
}

// =============================================================================
// models
// =============================================================================

// npmOf is the AI SDK package a model id suggests: Claude on /v1/messages,
// OpenAI's on /v1/responses, the rest on /v1/chat/completions. New API serves
// all three, and its own /v1/models may say which of them a model supports
// (supported_endpoint_types: "openai", "openai-response", "anthropic",
// "gemini", …), which npmFor prefers over this guess.
function npmOf(id) {
  const s = String(id).toLowerCase()
  if (/^claude-/.test(s) || s.startsWith("anthropic/")) return MESSAGES
  if (/^(gpt-|o\d|codex-|chatgpt-)/.test(s)) return RESPONSES
  return CHAT
}

// npmFor is the endpoint a model is spoken to on. The relay's own endpoint
// hint wins when it has one; the name is the fallback. A model that lists only
// non-chat endpoints (embeddings, image generation, …) is not a chat model and
// is dropped by the caller.
const CHAT_ENDPOINTS = ["openai", "openai-response", "anthropic", "gemini"]
function npmFor(m) {
  const preferred = npmOf(m.id)
  const eps = Array.isArray(m.endpoints) ? m.endpoints : []
  if (!eps.length) return preferred
  const want = preferred === MESSAGES ? "anthropic" : preferred === RESPONSES ? "openai-response" : "openai"
  if (eps.includes(want)) return preferred
  if (eps.includes("anthropic")) return MESSAGES
  if (eps.includes("openai-response")) return RESPONSES
  return CHAT
}

const isChatModel = (m) => {
  const eps = Array.isArray(m.endpoints) ? m.endpoints : []
  return !eps.length || eps.some((e) => CHAT_ENDPOINTS.includes(e))
}

const LEVELS = ["low", "medium", "high"]
const variantsOf = (levels) => Object.fromEntries(levels.map((l) => [l, {}]))

// runtimeModel is magpie's model for one id. Whether it thinks, and its
// reasoning levels, come from models.dev (known) when there is an entry, else
// from the endpoint and the name.
function runtimeModel(m, url, providerID, known, was, npmOverride) {
  const npm = npmOverride ?? npmFor(m)
  const kept = was?.variants && typeof was.variants === "object" && Object.keys(was.variants).length ? was.variants : undefined
  const reasoning = known ? known.reasoning : !!kept || npm !== CHAT || /think|reason|^o\d|gpt-5|qwq|r1/i.test(m.id)
  const levels = known?.levels?.length ? known.levels : undefined
  return {
    id: m.id,
    providerID,
    name: m.name,
    api: { id: m.id, url, npm },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: known ? { ...known.limit } : { context: 0, output: 0 },
    capabilities: {
      temperature: true,
      reasoning,
      attachment: npm !== CHAT,
      toolcall: true,
      input: { text: true, image: npm !== CHAT, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: typeof known?.interleaved === "object" ? { ...known.interleaved } : (known?.interleaved ?? false),
    },
    release_date: "",
    variants: !reasoning ? {} : levels ? variantsOf(levels) : (kept ?? variantsOf(LEVELS)),
  }
}

// MODELS_DEV is models.dev's catalogue, asked at most once a day and kept on
// disk so a magpie restart (as when the plugin's options change) doesn't ask
// again. It is only a help: it never fails or holds up the model list.
const MODELS_DEV = "https://models.dev/api.json"
const KNOWN_TIMEOUT = 5_000
const KNOWN_FOR = DAY * 1000
const KNOWN_RETRY = 10 * 60 * 1000
let asking

function keptFile() {
  const home = homedir()
  const dir = process.env.XDG_CACHE_HOME || (process.platform === "darwin" ? join(home, "Library", "Caches") : join(home, ".cache"))
  return join(dir, "magpie-newapi", "models-dev.json")
}

async function kept() {
  try {
    const k = JSON.parse(await readFile(keptFile(), "utf8"))
    if (Number.isFinite(k?.at) && k.models && typeof k.models === "object") return { at: k.at, ok: k.ok === true, models: k.models }
  } catch {}
  return { at: 0, ok: false, models: {} }
}

async function keep(k) {
  const file = keptFile()
  try {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(k))
    await rename(tmp, file)
  } catch {}
}

function knownOf(m) {
  const levels = []
  for (const o of Array.isArray(m.reasoning_options) ? m.reasoning_options : []) {
    if (o?.type !== "effort" || !Array.isArray(o.values)) continue
    for (const v of o.values) if (typeof v === "string" && v.trim() && !levels.includes(v.trim())) levels.push(v.trim())
  }
  const il = m.interleaved
  const size = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0)
  return {
    reasoning: m.reasoning === true,
    levels,
    interleaved: il === true ? true : typeof il?.field === "string" && il.field ? { field: il.field } : false,
    limit: { context: size(m.limit?.context), output: size(m.limit?.output) },
  }
}

// officialOf keeps only a model's official entry (the one whose provider is
// the model's canonical owner), so a reseller's row for the same id is no word
// on it.
function officialOf(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("models.dev: not a catalogue")
  const out = {}
  for (const [pid, p] of Object.entries(body)) {
    const models = p?.models && typeof p.models === "object" ? p.models : {}
    for (const [id, m] of Object.entries(models)) {
      if (Object.hasOwn(out, id) || typeof m?.canonical_model_id !== "string") continue
      if (m.canonical_model_id.split("/")[0] === pid) out[id] = knownOf(m)
    }
  }
  return out
}

async function knownModels() {
  const k = await kept()
  if (Date.now() - k.at < (k.ok ? KNOWN_FOR : KNOWN_RETRY)) return new Map(Object.entries(k.models))
  asking ??= (async () => {
    let next
    try {
      const res = await fetch(MODELS_DEV, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(KNOWN_TIMEOUT) })
      if (!res.ok) throw new Error(`models.dev: ${res.status}`)
      next = { at: Date.now(), ok: true, models: officialOf(await res.json()) }
    } catch {
      next = { ...k, at: Date.now(), ok: false }
    }
    await keep(next)
    return new Map(Object.entries(next.models))
  })().finally(() => {
    asking = undefined
  })
  return asking
}

// fetchModels is what GET /v1/models lists for a relay key. New API answers in
// OpenAI's shape ({data:[{id, …}]}); an Anthropic shape or a bare array is
// accepted too.
async function fetchModels(base, key) {
  const res = await fetch(base + "/v1/models", {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {}
  if (!res.ok) {
    const why = body?.error?.message ?? body?.message ?? (text.trim().slice(0, 200) || res.statusText)
    const err = new Error(`${res.status} ${why}`)
    if (res.status === 401) err.signIn = "expired"
    throw err
  }
  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null
  if (!list) throw new Error("/v1/models: unexpected reply")
  const out = {}
  for (const m of list) {
    const id = typeof m === "string" ? m : m?.id
    if (typeof id !== "string" || !id) continue
    const name = (typeof m === "object" && (m.display_name || m.name)) || id
    const eps = typeof m === "object" && Array.isArray(m.supported_endpoint_types) ? m.supported_endpoint_types.filter((e) => typeof e === "string") : []
    out[id] = { id, name, endpoints: eps }
  }
  return out
}

// =============================================================================
// dashboard: login, balance, subscription, and the account's keys
// =============================================================================

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
// iso accepts Unix seconds (New API's own), Unix milliseconds, or an RFC 3339
// string, and returns an ISO string.
const iso = (v) => {
  if (typeof v === "string" && v) {
    const t = Date.parse(v)
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined
  }
  const n = num(v)
  if (n === undefined || n <= 0) return undefined
  return new Date(n > 1e12 ? n : n * 1000).toISOString()
}
const pct = (used, limit) => (limit > 0 ? (100 * used) / limit : used > 0 ? 100 : 0)

// savedUserId is the user id the account saved at sign-in, if any.
function savedUserId(auth) {
  const v = auth?.metadata?.userId
  return v === undefined || v === null || String(v).trim() === "" ? undefined : v
}

// usageOf builds magpie's usage from the site's own replies.
async function usageOf(client, id, auth, base) {
  const status = (await httpJson(base, "/api/status", { markSignIn: false }))?.data ?? {}
  const perUnit = num(status.quota_per_unit) > 0 ? status.quota_per_unit : 500000
  const rawSymbol = typeof status.custom_currency_symbol === "string" ? status.custom_currency_symbol : ""
  // "¤" is New API's generic placeholder; a plain "$" reads better than it
  const symbol = rawSymbol && rawSymbol !== "¤" ? rawSymbol : "$"
  const money = (units) => symbol + (Math.round((units / perUnit) * 100) / 100).toFixed(2)

  // the optional access token (metadata.balanceToken) reads the dashboard; the
  // relay key (auth.key) only serves models and cannot read the console API
  const token = balanceTokenOf(auth)
  const userId = savedUserId(auth)
  const self = (await httpJson(base, "/api/user/self", { token, userId }))?.data ?? {}
  let active = []
  let all = []
  try {
    const s = (await httpJson(base, "/api/subscription/self", { token, userId }))?.data ?? {}
    if (Array.isArray(s.subscriptions)) active = s.subscriptions
    if (Array.isArray(s.all_subscriptions)) all = s.all_subscriptions
  } catch {}
  let plans = []
  try {
    const p = (await httpJson(base, "/api/subscription/plans", { token, userId }))?.data
    if (Array.isArray(p)) plans = p
  } catch {}

  const planTitle = {}
  for (const p of plans) if (p && p.id !== undefined) planTitle[p.id] = p.title || p.subtitle || ""

  const now = Date.now()
  const isLive = (sub) => {
    if (!sub || sub.status !== "active") return false
    const end = iso(sub.end_time)
    return end === undefined ? true : Date.parse(end) > now
  }
  let subs = active.filter((e) => isLive(e?.subscription ?? e))
  if (!subs.length) subs = all.filter((e) => isLive(e?.subscription ?? e))

  const out = {
    user: self.username || self.display_name || self.email || undefined,
    windows: [],
  }
  if (num(self.quota) !== undefined) out.balance = money(self.quota)

  const titles = []
  let until
  for (const entry of subs) {
    const sub = entry?.subscription ?? entry
    if (!sub) continue
    const total = num(sub.amount_total) ?? 0
    const used = num(sub.amount_used) ?? 0
    const name = planTitle[sub.plan_id] || "Subscription"
    titles.push(name)
    if (total > 0) {
      out.windows.push({
        name,
        used: pct(used, total),
        display: `${money(used)} / ${money(total)}`,
        ...(iso(sub.next_reset_time) ? { resetsAt: iso(sub.next_reset_time) } : {}),
      })
    } else {
      out.windows.push({ name, used: 0, display: "Unlimited" })
    }
    const end = iso(sub.end_time)
    if (end && (!until || Date.parse(end) < Date.parse(until))) until = end
  }
  if (titles.length) out.plan = [...new Set(titles)].join(", ")
  else if (typeof self.group === "string" && self.group) out.plan = self.group
  if (until) out.until = until
  // A wallet has no cap, so it is not a window: magpie would draw it as a
  // "100% left" bar, which a balance-based site never has. Only `balance` is
  // reported then.

  return out
}

// =============================================================================
// the sites in the plugin's options
// =============================================================================

// stringList reads an array of strings (model ids or /regex/) from options.
function stringList(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : []
}

// modelAllowed says whether a model id passes a site's allow/deny lists. A
// pattern written /like-this/ is a regular expression; anything else is an
// exact id or a trailing-* prefix.
function modelAllowed(id, allow, deny) {
  const hit = (pat) => {
    if (pat.startsWith("/") && pat.endsWith("/") && pat.length > 2) {
      try {
        return new RegExp(pat.slice(1, -1), "i").test(id)
      } catch {
        return false
      }
    }
    if (pat.endsWith("*")) return id.toLowerCase().startsWith(pat.slice(0, -1).toLowerCase())
    return id === pat
  }
  if (deny?.length && deny.some(hit)) return false
  if (allow?.length) return allow.some(hit)
  return true
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/

function slug(base) {
  return hostOf(base).toLowerCase().replace(/:\d+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
}

function sitesOf(options, tell) {
  const list = Array.isArray(options?.sites) ? options.sites : []
  const out = []
  const seen = new Set([ID])
  for (const [i, s] of list.entries()) {
    const why = (m) => tell && console.error(`magpie-newapi: options.sites[${i}] left out: ${m}`)
    // a site may pin its address or leave it to each sign-in; with no address
    // an explicit id is required
    const hasURL = typeof s?.url === "string" && s.url.trim() !== ""
    if (hasURL) {
      const bad = checkURL(s.url)
      if (bad) {
        why(bad)
        continue
      }
    }
    const base = hasURL ? root(s.url) : undefined
    const id = typeof s.id === "string" && s.id.trim() ? s.id.trim() : base ? slug(base) : ""
    if (!id) {
      why("no id, and no url to derive one from")
      continue
    }
    if (!ID_RE.test(id)) {
      why(`id "${id}": lower-case letters, digits, - and _, at most 40`)
      continue
    }
    if (seen.has(id)) {
      why(`id "${id}" is taken`)
      continue
    }
    if (out.length === SLOTS) {
      why(`only ${SLOTS} sites can be providers`)
      continue
    }
    seen.add(id)
    const name = typeof s.name === "string" && s.name.trim() ? s.name.trim() : id
    // optional model filters: a site may expose only a subset (a "model
    // combination"), either an allow list or a deny list
    const models = stringList(s.models)
    const exclude = stringList(s.exclude ?? s.excludeModels)
    out.push({ id, name, base, models, exclude })
  }
  return out
}

// =============================================================================
// the plugin
// =============================================================================

const NAME_PROMPT = {
  type: "text",
  key: "name",
  message: "Instance name (optional; empty uses the site's host and the key's end)",
  placeholder: "",
}

const REGION_PROMPT = (site) =>
  site?.base
    ? []
    : [{ type: "text", key: "baseURL", message: "New API address", placeholder: "https://api.example.com", validate: checkURL }]

// hooks are one provider's: id, with its site fixed (a site from the options)
// or each account's own (the "newapi" provider's, asked at sign-in).
//
// One sign-in is one complete instance: a base URL, a relay API key (auth.key),
// and optionally a system access token that only reads the dashboard so the
// balance / subscription can be shown. Several such instances pool under the
// one provider and jointly serve the same models.
function hooks(client, id, site) {
  const baseOf = (auth) => site?.base ?? root(auth?.metadata?.baseURL)

  return {
    auth: {
      provider: id,
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        const base = baseOf(auth)
        if (!base) return {}
        await named(client, id, auth, base)
        // Bearer for chat / responses, x-api-key for messages: New API's relay
        // accepts either
        return { baseURL: base + "/v1", apiKey: auth.key }
      },
      // One sign-in collects, in this order: base URL, API key, optional
      // system access token (balance only), optional user id.
      //
      // It is an oauth method with an auto callback, not an api method, because
      // an api method always asks its key box *after* the prompts; this way the
      // key is asked in the natural place, and the plugin can validate it and
      // the access token before saving anything.
      methods: [
        {
          type: "oauth",
          label: site ? `${site.name} API key` : "New API API key",
          prompts: [
            ...REGION_PROMPT(site),
            { type: "password", key: "apiKey", message: "API key (sk-…)", placeholder: "sk-…" },
            {
              type: "password",
              key: "accessToken",
              message: "System access token for balance / subscription (optional)",
              placeholder: "nap_… or a legacy token; empty skips balance",
            },
            {
              type: "text",
              key: "userId",
              message: "User id (only needed for a legacy access token)",
              placeholder: "e.g. 42",
              condition: (i) => !!(i?.accessToken && i.accessToken.trim()),
            },
          ],
          async authorize(inputs) {
            return {
              url: "",
              instructions: "",
              method: "auto",
              async callback() {
                const base = site?.base ?? root(inputs?.baseURL)
                if (!base) return { type: "failed", error: "No New API address given" }
                const apiKey = String(inputs?.apiKey ?? "").trim()
                if (!apiKey) return { type: "failed", error: "No API key given" }
                const accessToken = String(inputs?.accessToken ?? "").trim()
                const userId = String(inputs?.userId ?? "").trim() || undefined

                // validate the relay key by listing its models
                let listed
                try {
                  listed = await fetchModels(base, apiKey)
                } catch (e) {
                  return { type: "failed", error: `The API key did not work: ${String(e?.message ?? e).slice(0, 300)}` }
                }
                // validate the optional balance token against the dashboard
                let user
                if (accessToken) {
                  try {
                    user = (await httpJson(base, "/api/user/self", { token: accessToken, userId, markSignIn: false }))?.data
                  } catch (e) {
                    return { type: "failed", error: `The access token did not work: ${String(e?.message ?? e).slice(0, 300)}` }
                  }
                }
                const metadata = {
                  baseURL: site?.base ? undefined : base,
                  balanceToken: accessToken || undefined,
                  userId,
                }
                const name = user?.username || hostOf(base) + " …" + apiKey.slice(-4)
                return { type: "success", key: apiKey, metadata, accountId: name }
              },
            }
          },
        },
      ],
      // magpie's: the wallet balance and the subscriptions' remaining amount,
      // read only when a system access token was saved
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api") return { error: "not signed in" }
        const base = baseOf(auth)
        if (!base) return { error: "No New API address saved with this key; sign in again" }
        const user = label(auth, base)
        if (!balanceTokenOf(auth)) return { user }
        await named(client, id, auth, base)
        try {
          return { user, ...(await usageOf(client, id, auth, base)) }
        } catch (e) {
          return { user, error: String(e?.message ?? e), windows: [], ...(e?.signIn ? { signIn: e.signIn } : {}) }
        }
      },
    },
    provider: {
      id,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api" || !auth.key) return provider.models
        const base = baseOf(auth)
        if (!base) return provider.models
        await named(client, id, auth, base)
        try {
          const listed = await fetchModels(base, auth.key)
          if (!listed || !Object.keys(listed).length) return provider.models
          const known = await knownModels()
          const out = {}
          for (const m of Object.values(listed)) {
            if (!isChatModel(m)) continue
            if (!modelAllowed(m.id, site?.models, site?.exclude)) continue
            out[m.id] = runtimeModel(m, base + "/v1", id, known.get(m.id), provider?.models?.[m.id])
          }
          return out
        } catch (e) {
          if (e?.signIn) throw e
          return provider.models
        }
      },
    },
  }
}

// The provider a plugin function offers: its own site when the options list
// one at that slot, else the first site, else the ad-hoc "newapi" provider
// (whose sign-ins each carry their own address).
//
// Every exported function must return a provider, because magpie's community
// check requires each one to have an auth hook. An unconfigured slot therefore
// offers the same provider as the first, and magpie merges providers by id, so
// no empty rows appear.
function offered(sites, i) {
  return sites[i] ?? sites[0] ?? null
}

function providerFor(client, sites, i) {
  const site = offered(sites, i)
  return hooks(client, site?.id ?? ID, site)
}

export async function NewapiPlugin({ client } = {}, options) {
  return providerFor(client, sitesOf(options, false), 0)
}

const slot = (i) => async ({ client } = {}, options) => {
  return providerFor(client, sitesOf(options, i === 0), i)
}

export const NewapiSite1 = slot(0)
export const NewapiSite2 = slot(1)
export const NewapiSite3 = slot(2)
export const NewapiSite4 = slot(3)
export const NewapiSite5 = slot(4)
export const NewapiSite6 = slot(5)

// _internal is what the tests reach into; it is not a plugin.
export const _internal = {
  ID,
  root,
  checkURL,
  hostOf,
  label,
  npmOf,
  npmFor,
  isChatModel,
  runtimeModel,
  fetchModels,
  usageOf,
  balanceTokenOf,
  sitesOf,
  modelAllowed,
}
