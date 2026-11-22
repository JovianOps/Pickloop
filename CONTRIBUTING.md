# Contributing to PickLoop

## Setup and run

- Use Node.js 18 or newer with npm.
- PickLoop has no third-party dependencies, so `npm install` is not required.
- Run `npm start`, then open <http://localhost:3000>.
- Run the test suite with `npm test`.

## Contribution workflow

Make a focused branch and change, keep the patch limited to the issue, and describe the user-visible behavior and verification in your pull request. Do not include generated decision data or secrets.

## Code and tests

Keep the app lightweight: browser code is plain JavaScript and the server uses Node's built-in modules. Follow the existing CommonJS style, use clear names, escape user-provided text before rendering it, and keep validation and scoring deterministic. Treat recovery links as host secrets; never include them in guest invites or ordinary API responses. Prefer accessible semantic HTML and responsive CSS; no formatter or linter is configured.

Add or update focused tests in `test/` with Node's built-in `node:test` and `node:assert`. Cover validation and the affected end-to-end behavior where practical, then run `npm test` before submitting.

## MVP scope

Options are manually curated by the host. Do not add accounts/login, chat ingestion, contact sync, venue search, native apps, payments, identity-level anti-fraud, or hidden AI decisions without a deliberate product decision. Keep changes focused on the no-login group decision flow.
