# Gateway allowance contract

The deployed gateway's contract was located and read-only access verified on 2026-10-28. This document
records its client-facing behavior without deployment addresses, credentials, or private account data.
Implemented in **0.5.0-test.3** as the explicit **Gateway** connection type.

## Authentication and routes

Use the connection's gateway bearer token, independently of direct OpenRouter credentials. An
OpenRouter management key is for administration; it cannot be used for chat completions. The gateway
keeps its upstream key pair private.

Given an API base URL ending in `/v1`, the gateway supports:

- `GET /v1/models` and `GET /v1/models/user?output_modalities=all`: filtered OpenAI-shaped model lists
  retaining OpenRouter context, capabilities, and pricing metadata.
- `POST /v1/chat/completions`: original request/response bodies and incremental SSE.
- `GET /healthz`: authenticated service marker, not an upstream-health guarantee.
- `GET /lab/allowance`: origin-relative, **not** appended to the API base path.

All these routes require authentication. Keep TLS certificate and hostname verification enabled; a
private-CA deployment requires the client process to trust its public CA certificate. Never export
private CA/server keys or enrollment records into extension source, logs, attachments, or settings.

The gateway deliberately does not expose `/v1/key`, `/v1/credits`, presets, Files, generation, or
management APIs. Do not probe these as a fallback for missing allowance data. Discovery failures return
an error rather than an unrestricted catalog; the adapter must also fail closed.

## Allowance response

The top-level response contains `cheap`, `default`, and `fetched_at`. Each lane has normalized budget
fields `limit`, `remaining`, `reset`, `usage`, `resets_at`, and `include_byok`, plus:

| Field | Meaning |
| --- | --- |
| `status` | `reported` or `unknown`; an upstream read failure makes only that lane unknown. |
| `effective_budget` | Effective budget object using the same normalized fields. |
| `applicable_budgets` | Applicable counters, including the key's explicit limit. |
| `inherited_budgets` | Applicable counters excluding the own-key limit. |

Numeric budget fields and reset times may be null. Root `limit`/`remaining` describe the explicit key
cap, while root `usage` is cumulative key usage. Prefer `effective_budget` for interval allowance,
interval usage, reset period, and next reset. A null explicit key limit does not mean unlimited access.
Unknown data must remain unknown rather than becoming zero spend or unlimited credit.

Show the lanes separately, including partial, stale, and unknown states. Never add daily and weekly
allowances. Direct connections and the gateway may use the same upstream pair; accessing both does not
create additional funds. `fetched_at` is retrieval time, not proof of instantaneous billing counters.

## Verified readiness and remaining work

Read-only checks passed against the actual deployment: authenticated HTTPS health and model discovery,
unauthenticated refusal, and both effective-budget response shapes. The OpenRouter management API was
also reachable with its separate management credential. These checks made no inference calls and
changed no keys, budgets, guardrails, or running services.

The adapter validates each lane independently, uses effective interval budgets in the panel/status bar,
and retains failed readings as visibly stale. Missing or malformed counters remain unknown. Credential,
endpoint, enabled-state, and deletion revisions prevent older reads from publishing new state. An
allowance refresh calls only origin-relative `/lab/allowance`, with redirect following disabled.

Bounded live checks through the compiled production provider verified tool streaming, tool-result
continuation, direct/gateway credential and accounting isolation, and both allowance lanes. See
[verification status](verification.md) for limits and client CA-trust settings. Stubbed regression tests
remain network-free.

Gateway discovery accepts only its filtered `/models` response; empty catalogs offer no models,
malformed/error responses do not fall back, and manual model additions are unavailable. Requests retain
OpenRouter session, reasoning, and cache fields while credit/preset APIs stay direct-only.
Deployment-specific access remains with the operator and is not part of the public repo.
