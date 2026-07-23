# Dependency license audit

Audit date: 2026-07-23

The local companion is installed with the production dependency tree pinned by `package.json` and `pnpm-lock.yaml`. The project itself remains `UNLICENSED`; dependency licenses do not grant a license to the project source.

## Results

The package manager reported 92 uniquely named production packages and no missing license declaration:

| License expression | Unique package names |
| --- | ---: |
| MIT | 82 |
| ISC | 7 |
| BSD-3-Clause | 2 |
| BSD-2-Clause | 1 |

The three direct production dependencies are licensed under MIT:

- `@modelcontextprotocol/sdk` `1.29.0`
- `ws` `8.21.1`
- `zod` `4.4.3`

The non-MIT transitive entries are:

- BSD-3-Clause: `fast-uri`, `qs`
- BSD-2-Clause: `json-schema-typed`
- ISC: `inherits`, `isexe`, `once`, `setprototypeof`, `which`, `wrappy`, `zod-to-json-schema`

`pnpm audit --prod` reported zero known vulnerabilities at every severity for the resolved production tree at the audit date.

The audit initially identified vulnerable transitive releases below `fast-uri` `3.1.4` and `@hono/node-server` `2.0.5`. The direct MCP SDK dependency did not yet expose a dependency range that could resolve both fixes without assistance, so `pnpm-workspace.yaml` overrides those vulnerable ranges for the locked pnpm tree and `package.json` declares the equivalent npm overrides. The refreshed pnpm lockfile resolves `fast-uri` `3.1.4` and `@hono/node-server` `2.0.11`; the syntax checks, unit tests, companion tests, and real-browser extension E2E suite pass with that tree.

## Reproduce the audit

Run these commands after installing the locked dependencies:

```bash
pnpm licenses list --prod --json
pnpm audit --prod --json
```

This inventory is an engineering check, not legal advice. Re-run it whenever the lockfile changes. If a release package starts redistributing dependency source or binaries instead of installing them from the package registry, include the license texts and notices required by those packages in that distribution.
