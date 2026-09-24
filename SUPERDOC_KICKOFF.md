# SuperDoc Integration — Kickoff Checklist (from Plan v4 FINAL)

## Day 0
- [ ] Branch `feat/cfc-v4-superdoc`
- [ ] Node >= 22.12
- [ ] Copy sample DOCX fixtures into `packages/doc-fixtures/`
- [ ] License note `docs/licensing-superdoc.md`
- [ ] Freeze Streamlit feature work

## Day 1
- [ ] pnpm workspace monorepo scaffold (`web`, `api`, `doc-worker`)
- [ ] `pnpm add @superdoc-dev/react` in `apps/web`
- [ ] Client-only dynamic import wrapper
- [ ] `/dev/superdoc-spike` open + export Word-roundtrip pass

## Day 2
- [ ] FastAPI `GET/PUT /dev/drafts/{id}/file` local disk versions
- [ ] Studio load Blob → edit → export Blob → PUT → reload pass

## Day 3
- [ ] `/drafts/{id}/session` returns role + documentMode
- [ ] Fake personas: Arpit editor, Aashna suggester
- [ ] Illegal save blocked when viewing

## Day 4
- [ ] `apps/doc-worker` + `@superdoc-dev/sdk`
- [ ] Placeholder replace on template → open in Studio

## Day 5
- [ ] Thin submit → L1 suggesting → version chain
- [ ] Ready to expand full RBAC + RAG (Phases 1–2 parallel)
