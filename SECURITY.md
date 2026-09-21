# Security

## What this project is

`internal-tools` is a **prototype stand**, not a hardened product. It runs on a single host under Docker Compose,
listens on `127.0.0.1` by default, and generates its own secrets into a local `.env` on first start. The threat
model it demonstrates — a coding agent that must not be able to reach data except through one audited gateway —
is real and enforced, but the surrounding setup is meant for a laptop, not for the internet.

Before pointing it at anything real:

- Do not expose the stand to a public network. `make lan` opens it to the local network on purpose and says so;
  there is no rate limiting, no WAF and no hardening in front of it.
- Keycloak runs in stand configuration (plain HTTP behind Traefik, permissive dev settings). A corporate setup
  would use the company IdP over TLS — that is a roadmap item, not a drop-in change.
- The Gitea administrator account is stored in the stand's `.env` and is used by bootstrap. Anyone with access
  to that file can lift branch protection.
- A tool's client secret reaches its container as an environment variable and is visible in `docker inspect`.
- Demo data in `infra/postgres/init` and the employee directory in `registry/directory.yaml` are fictional.
  Replace them; do not add real personal data to a checkout you intend to share.

## Reporting a vulnerability

Please report privately first: open a GitHub **security advisory** on this repository
(`Security` → `Report a vulnerability`), or open a regular issue if the problem is not exploitable.

Useful in a report: what boundary was crossed (admission contract, gateway scope, data rights, identity, tool
access, write confirmation, lifetime), how to reproduce it on a clean `make up`, and what the audit log shows.

Since this is a prototype maintained in spare time, there is no response-time commitment. Fixes land as normal
pull requests.

## What counts as a bug worth reporting

Anything that lets a tool or an agent step outside the four invariants:

- reading a source, dataset or field the manifest does not declare, or that the caller's groups do not allow;
- seeing rows outside the caller's row scope;
- applying a write without an explicit permission, or without the human decision the channel requires;
- acting without a valid signed identity, or with one minted for a different audience;
- opening a tool the gateway did not grant access to;
- a call that changes data and leaves no audit record;
- escaping the tool network to anything other than the gateway;
- keeping a tool alive past its TTL and auto-extension cap.
