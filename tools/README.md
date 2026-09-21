# tools/

Empty on purpose — but not ignored: tools you create here are committed and go to production through a PR,
like everything else.

This is where tools live on a running stand, and tools do not travel between stands: a tool has an owner, a
lifetime and a registration in one particular gateway. Copying someone else's `tools/` into your checkout would
give you code that no gateway admits, with an owner who is not you.

To get a tool here, create one on your own stand — the sandbox MCP server does it:

```
scaffold_tool { name, title, description, owner, sources, writes }
```

`bin/sandbox-mcp platform` is the server; `make agents` writes the configs for Claude Code, Cursor and OpenCode.
The skeleton it copies from is in `templates/new-tool/`, and the rules the agent follows are in `AGENTS.md`.

The platform's own checks pass with zero tools: `make check` prints `0 из 0`.
