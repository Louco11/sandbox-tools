# internal-tools

A sandbox where an **agent builds an internal web app over corporate data in hours** — because the boundaries are
set in advance and enforced by machine, not by review.

Most internal tools are one-off: a report for one quarter, a board for one migration. They never survive a
product backlog, so people do them in spreadsheets. This gives them a legal way to exist — a narrow contract to
get in, one audited gateway to the data, a shared framework, and a death date.

Prototype, single host, Docker Compose. Full walkthrough: [README.ru.md](README.ru.md) · agent rules:
[AGENTS.md](AGENTS.md) · plans: [docs/roadmap.md](docs/roadmap.md) (Russian).

## Start

```bash
sh infra/setup.sh        # checks the environment, brings the stand up, verifies it, prints what to do next
```

Needs Docker, Node ≥ 22.18, `jq`. Secrets are generated locally into `.env`. `--check` only diagnoses.

Or open the repository in Claude Code, Cursor or OpenCode and say: **"read AGENTS.md and set up the sandbox"** —
the agent runs the same script, then builds tools through the `sandbox` MCP server.

| | |
| --- | --- |
| Portal — catalog, sources, metrics, events | http://tools.localhost:18000 |
| A tool | `http://<tool>.tools.localhost:18000` |
| Gitea · Keycloak · identity · gateway | `:13000` · `auth.` · `id.` · `:18080` |

## The four invariants

Break one and it stops being a sandbox.

1. **Admission contract.** A tool enters only with a valid `tool.yaml`: approved sources, explicit writes, owner,
   lifetime, who it is open to. CI checks it against `registry/sources.yaml`. Not in the registry — build fails.
2. **One exit to the data.** No database drivers in the SDK, no route out of the tool network except the
   gateway, dependency check in CI. The gateway issues a token scoped to the manifest and audits every call.
3. **One framework.** Auth, data access, deployment, UI come from `packages/*` and `charts/tool-base`. A tool is
   domain logic only, so platform changes reach every tool without touching them.
4. **Forced mortality.** Every tool has a TTL. Human use extends it, an agent's calls do not. Idle long enough —
   the owner is notified, then it is deleted with its resources. Silence counts as "no".

A human decides twice: approving a source in the registry, and looking at the preview link. Everything between
is automatic.

## How a tool ships

```
agent ──scaffold_tool──▶ git push ──▶ CI: contract + types ──▶ deployer ──▶ preview link
                                      (no secrets, no Docker,        │
                                       no route to the gateway)      ▼
                                                        human approves the PR ──▶ production
```

## What is actually enforced

| Boundary | By what |
| --- | --- |
| Source not in the registry | manifest validator, in CI and in the gateway |
| Tool reaching a database | internal network, no drivers, dependency check |
| Field the person may not see | gateway blanks it by group, reports it in `redacted` |
| Rows outside one's scope | row filter from the registry, scope returned in `row_scope` |
| Any write | explicit permission; UI applies on click, an agent may only prepare and then `commit_approved` with the human's verbatim consent |
| Who may open a tool | ForwardAuth before the tool, gateway again on the call |
| Who the caller is | short-lived JWT from the identity service (`sub`, `groups`, `channel`, `aud`) |
| Living forever | reaper: TTL, auto-extension cap, idle notice, deletion |
| Pushing to `main` | PR, green CI, human approval |

Every call, allowed or denied, lands in `audit.calls` before the effect — with the actor, the tool, the source,
the reason, and whether an agent was in the chain.

Identity is real: Keycloak as the IdP, `infra/identity` for the OIDC flow (PKCE in browsers, device flow for
agents) and for the signed `X-Sandbox-Identity` header. An agent's MCP key belongs to the human, not to the tool:
only its prefix and hash are stored, groups are re-read on every call, revocation is immediate. The identity
carries a channel — from a browser a person may confirm a write, from an agent host they must say yes in chat.

## Layout

```
registry/      approved sources and the people directory — the two human decisions
gateway/       the only way to data: scope, data rights, writes, audit, MCP endpoint
infra/         identity, deployer, reaper, notifier, CI runner, Postgres seed, demos, setup
packages/      sdk, ui-kit, manifest, connector — what tools and connectors import
portal/        catalog, tool page, sources, metrics, events, admin
connectors/    a service per source, behind the gateway
mcp-sandbox/   MCP server for build-time agents
templates/     skeletons for a new tool and new connectors
tools/         empty on purpose — see tools/README.md
```

## Try the boundaries

```bash
make demo-gateway       # scope, injections, two-step writes, audit — 15 assertions
make demo-identity      # sign-in, signed identity, personal MCP keys
make demo-access        # who may open a tool, and why the gateway says no
make demo-data-rights   # sensitive fields by group, row filters, writes by group
make demo-connector     # a second source added by a registry entry, no gateway code
make check              # admission contract + types, the same checks CI runs
```

## Limits

Prototype on one host: no Kubernetes, no HA, no real corporate sources yet. Keycloak runs in stand
configuration, the employee directory is a stub, a tool's secret is visible in `docker inspect` on the host, and
the Gitea admin account lives in `.env`. Do not point this at real data as is — see [SECURITY.md](SECURITY.md).

[Apache-2.0](LICENSE) · [NOTICE](NOTICE)
