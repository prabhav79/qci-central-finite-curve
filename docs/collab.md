# Real-time collaboration (Hocuspocus / Yjs)

**Status: Sprint 5 scaffold, server-only. Client wiring lands in Sprint 5.5.**

## What ships in Sprint 5

- `apps/collab` — Hocuspocus (Yjs sync backend) with Postgres persistence
- `npm run dev:collab` — starts it on `ws://127.0.0.1:8200`
- `docker compose --profile collab up -d collab` — production shape
- Postgres table `collab_documents(name, data, updated_at)` auto-created on first boot

## Why the SuperDoc client isn't wired yet

SuperDoc 2's Yjs binding API is version-fragile — the provider prop name, the
Y.Doc handoff, and awareness state shape have all shifted across recent
minor releases. Wiring the wrong shape ends up in silent no-op sync that
looks like it's working until two people race an edit.

Sprint 5.5 will pin a specific SuperDoc version, wire the provider, and
add a Playwright test that opens the same draft in two browser contexts
and verifies bidirectional awareness + text merge.

## Env

| Var | Default | Purpose |
|---|---|---|
| `COLLAB_PORT` | `8200` | WebSocket port |
| `DATABASE_URL` | (unset) | If set, docs persist to Postgres. Unset = in-memory only |
| `COLLAB_TOKEN` | (unset) | If set, clients must connect with `?token=<value>` |

## Manual smoke (server-only)

```bash
npm install
npm run dev:collab
# In another shell:
node -e "
  import('ws').then(({default: WS}) => {
    const s = new WS('ws://127.0.0.1:8200/cfc-draft-demo');
    s.on('open', () => { console.log('connected'); s.close(); });
    s.on('error', console.error);
  });
"
```

## Sprint 5.5 checklist

- [ ] Pin SuperDoc version + record its Yjs binding shape
- [ ] Frontend provider: `import { HocuspocusProvider } from '@hocuspocus/provider'`
- [ ] Pass provider to `<SuperDocEditor collaborationProvider={...}>` (exact prop name TBD from SuperDoc docs of the pinned version)
- [ ] Token via API: `GET /drafts/{id}/collab-token` returning `{token, doc_name}`
- [ ] Playwright: two contexts open the same draft, one types, other sees typed text within N ms
- [ ] Presence UI: show avatars of concurrent viewers in the Studio header
