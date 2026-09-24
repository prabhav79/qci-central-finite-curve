# SuperDoc licensing note (CFC)

**Status: proceeding under AGPL for internal use. Confirmed by Aashna (2026-09-23).**
Commercial license procurement is deferred until QCI leadership approves
external distribution of the CFC URL.

## Decision

We `npm i @superdoc-dev/react` from the public AGPL-3.0 package. Document
bytes stay in CFC/Railway storage; SuperDoc is a self-hosted editor + SDK,
not a SaaS. For an internal QCI demo and internal use, AGPL is sufficient.

**Revisit only when** leadership approves shipping the URL to external
parties (contractors, partner boards, the general public). At that point:

1. Ask sales@superdoc.dev for a Business/Enterprise quote (1 product,
   self-hosted, seat count based on QCI staff who will edit).
2. Add `SUPERDOC_LICENSE_KEY` to Railway env for `cfc-web`.
3. Verify SuperDoc telemetry disabled in the pinned version.

## Why AGPL is fine for internal use

- **No modified redistribution.** We ship SuperDoc unmodified via npm.
- **Access is internal.** AGPL §13's network-use clause obliges source
  disclosure to *users* of a modified version. Since we (a) don't modify
  it and (b) the users are QCI staff on QCI infra, this reduces to normal
  AGPL obligations, which the npm distribution already satisfies.
- **Data stays with us.** SuperDoc does not exfiltrate document bytes.
  DOCX files live in Railway storage under QCI control.

## When to escalate

- Any URL shared with a party outside QCI staff
- Any modification of SuperDoc source (we currently make none)
- Any repackaging that would count as distribution

## Decision log

- 2026-09-22 · Plan v4 D16: internal AGPL OK for dev; commercial required for public prod.
- 2026-09-23 · Aashna approved AGPL for the internal demo + prototype. Legal review deferred until leadership go/no-go.
