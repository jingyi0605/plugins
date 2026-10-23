# @magpie-community/opencode-newapi-auth

Signs in to a [New API](https://github.com/QuantumNous/new-api) (or One API)
relay site and makes its requests, in OpenCode and in magpie.
Provider id: `newapi`.

## Signing in

An account is one complete instance: a site address, a relay API key, and
optionally a system access token that only reads the dashboard.

The questions come in this order:

1. **New API address** — e.g. `https://api.example.com` (with or without `/v1`).
2. **API key** — the relay key (`sk-…`).
3. **System access token** — optional; only needed to show balance and
   subscription. Leave it empty to serve models only.
4. **User id** — only for a legacy access token.

Nothing is saved until both credentials are checked: the key against
`GET /v1/models`, the token against `GET /api/user/self`. A wrong one fails the
sign-in instead of leaving a broken account behind.

The account is kept where OpenCode keeps sign-ins (`auth.json`; in magpie,
`plugin-auth.json`) as `{ "type": "api", "key": <relay key>, "metadata": { "baseURL", "balanceToken", "userId" } }`.

Adding the same provider again adds another instance; they pool into one model
family, and magpie routes across them (a 401 marks an account for re-login, a
429/5xx fails over to the next).

## Requests

Every request goes to the site's own relay, `<baseURL>/v1`, with the account's
key. The endpoint follows the relay's own `supported_endpoint_types` from
`GET /v1/models` first, then the model's name:

| endpoint hint | SDK | path |
| --- | --- | --- |
| `anthropic` | `@ai-sdk/anthropic` | `/v1/messages` |
| `openai-response` | `@ai-sdk/openai` | `/v1/responses` |
| `openai` (or none) | `@ai-sdk/openai-compatible` | `/v1/chat/completions` |

Models that list only non-chat endpoints (`embeddings`, `image-generation`, …)
are left out. [models.dev](https://models.dev) supplies context/output limits
and reasoning levels when it has an entry; it never decides the protocol and
never blocks the model list.

## Usage

With a system access token saved, the account reports:

- **balance** — `GET /api/user/self` `quota` ÷ `GET /api/status` `quota_per_unit`,
  in the site's currency (`¤` shown as `$`);
- **subscriptions** — the active rows of `GET /api/subscription/self`, each a
  window with used/total, percent and next reset, named by
  `GET /api/subscription/plans`.

A wallet has no cap, so a balance-only site reports just the balance and no
quota window — otherwise magpie would draw a misleading "100% left" bar.

## Several providers, names and model combinations

By default there is one provider, `newapi`. To have several records — say a
Claude pool and a Codex pool from the same site — list them in the plugin's
options:

```json
{
  "sites": [
    { "id": "claude-pool", "url": "https://api.example.com", "models": ["claude-*"] },
    { "id": "codex-pool",  "url": "https://api.example.com", "models": ["gpt-*", "codex-*"] },
    { "id": "my-relay",    "models": ["/^deepseek-/"] }
  ]
}
```

| field | meaning |
| --- | --- |
| `id` | provider id; also the `<id>/<model>` prefix |
| `url` | the site address; **optional** — without it each sign-in supplies its own address |
| `models` | only expose matching models: exact id, `claude-*` prefix, or `/regex/` |
| `exclude` | hide matching models (wins over `models`) |

magpie fixes a plugin's provider list when it loads the plugin, so extra records
must be declared here; a plugin cannot add one at runtime. A row is named by its
id — rename it and tick which models it offers in magpie's provider settings,
which magpie keeps per provider.

## Limits

- A relay key cannot read the console API; balance and subscription need a
  system access token (Personal Settings → Security Settings).
- A site that only offers non-chat models (images, embeddings) leaves the model
  list empty.
- Password login is not used: sites with 2FA or Turnstile are fine, because only
  an access token is read.
