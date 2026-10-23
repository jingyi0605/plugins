// A tiny in-process New API stand-in for the unit tests. It speaks just the
// endpoints the plugin asks, with New API's shapes:
//   GET  /v1/models
//   GET  /api/status
//   GET  /api/user/login/encryption-key
//   POST /api/user/login
//   GET  /api/user/self
//   GET  /api/subscription/self
//   GET  /api/subscription/plans
// It also encrypts nothing (tests run it with encryption off), so a plain
// password is expected.
import { createServer } from "node:http"

export const RELAY_KEY = "sk-testkey-abcdef123456"
export const DISCOVERED_KEY = "sk-discovered-key-0001"
export const USER = { username: "ada", password: "s3cret" }
export const QUOTA_PER_UNIT = 500000
export const BALANCE_UNITS = 6_200_000 // $12.40

export function makeServer(overrides = {}) {
  const state = {
    requests: [],
    ...overrides,
  }
  const server = createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" })
      res.end(JSON.stringify(body))
    }
    const url = new URL(req.url, "http://x")
    const auth = req.headers.authorization || ""
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : auth
    state.requests.push({ method: req.method, path: url.pathname, auth: bearer })

    if (url.pathname === "/v1/models" && req.method === "GET") {
      if (bearer !== RELAY_KEY && bearer !== DISCOVERED_KEY) return send(401, { error: { message: "invalid token" } })
      return send(200, {
        object: "list",
        data: [
          { id: "gpt-4o", object: "model", supported_endpoint_types: ["openai", "openai-response"] },
          { id: "claude-3-5-sonnet", object: "model", supported_endpoint_types: ["anthropic", "openai"] },
          { id: "deepseek-chat", object: "model", supported_endpoint_types: ["openai"] },
          { id: "text-embedding-3-small", object: "model", supported_endpoint_types: ["embeddings"] },
        ],
      })
    }

    if (url.pathname === "/api/status") {
      return send(200, {
        success: true,
        data: { version: "0.9.0", quota_per_unit: QUOTA_PER_UNIT, display_in_currency: true, custom_currency_symbol: "$" },
      })
    }

    if (url.pathname === "/api/user/login/encryption-key") {
      return send(200, { success: true, data: { enabled: false } })
    }

    if (url.pathname === "/api/user/login" && req.method === "POST") {
      let raw = ""
      req.on("data", (c) => (raw += c))
      req.on("end", () => {
        let body = {}
        try {
          body = JSON.parse(raw)
        } catch {}
        if (body.username !== USER.username || body.password !== USER.password) {
          return send(200, { success: false, message: "用户名或密码错误" })
        }
        return send(200, {
          success: true,
          data: { access_token: "dash-" + Math.random().toString(36).slice(2), token_type: "Bearer", user: { id: 42, username: USER.username } },
        })
      })
      return
    }

    if (url.pathname === "/api/user/self") {
      if (!bearer.startsWith("dash-")) return send(401, { success: false, message: "unauthorized" })
      return send(200, {
        success: true,
        data: { id: 42, username: "ada", display_name: "Ada", group: "default", quota: BALANCE_UNITS, used_quota: 1_000_000 },
      })
    }

    if (url.pathname === "/api/subscription/self") {
      if (!bearer.startsWith("dash-")) return send(401, { success: false, message: "unauthorized" })
      if (state.noSubs) return send(200, { success: true, data: { subscriptions: [], all_subscriptions: [] } })
      return send(200, {
        success: true,
        data: {
          billing_preference: "subscription_first",
          subscriptions: [
            {
              subscription: {
                id: 1, plan_id: 7, amount_total: 5_000_000, amount_used: 1_250_000,
                start_time: 1_700_000_000, end_time: 1_900_000_000, next_reset_time: 1_800_000_000,
                status: "active",
              },
            },
          ],
        },
      })
    }

    if (url.pathname === "/api/subscription/plans") {
      if (!bearer.startsWith("dash-")) return send(401, { success: false, message: "unauthorized" })
      return send(200, { success: true, data: [{ id: 7, title: "Pro Plan", subtitle: "Monthly" }] })
    }

    if (url.pathname === "/api/token/" && req.method === "GET") {
      if (!bearer.startsWith("dash-")) return send(401, { success: false, message: "unauthorized" })
      return send(200, {
        success: true,
        data: {
          page: 1, page_size: 100, total: 2,
          items: [
            { id: 11, name: "Claude", status: 1, key: "sk-********0001", group: "default", unlimited_quota: false, remain_quota: 500000 },
            { id: 12, name: "disabled", status: 2, key: "sk-********0002", group: "default", unlimited_quota: false, remain_quota: 0 },
          ],
        },
      })
    }

    const keyMatch = url.pathname.match(/^\/api\/token\/(\d+)\/key$/)
    if (keyMatch && req.method === "POST") {
      if (!bearer.startsWith("dash-")) return send(401, { success: false, message: "unauthorized" })
      const id = Number(keyMatch[1])
      if (id !== 11) return send(200, { success: false, message: "not found" })
      return send(200, { success: true, data: { key: DISCOVERED_KEY } })
    }

    send(404, { success: false, message: "not found" })
  })
  return { server, state }
}

export async function listen(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const { port } = server.address()
  return `http://127.0.0.1:${port}`
}
