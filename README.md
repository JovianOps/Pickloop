# PickLoop

PickLoop helps a group choose a plan with a short ranked ballot. It has no accounts or external services.

## Run locally

Requires Node.js 18 or newer. From this folder:

```sh
npm start
```

Open <http://localhost:3000>. Create a decision, then share the guest link. The host page stays at `/host/<id>` in the browser that created the decision; bookmark it if you need to return later. The guest link is `/d/<id>` and expires after 30 days. Data is stored in `data/decisions.json` next to the app. Set `PICKLOOP_DATA_FILE` to use a different location.

Run the integration check with:

```sh
npm test
```

## Votes and privacy

Guests rank up to three options. First, second and third choices earn 3, 2 and 1 points. The highest score wins. Ties go to more first-place votes, then the host's original option order. A random browser token lets a guest update their ballot; the server stores one current ballot per token. There are no names, accounts, analytics, or external integrations. Anyone with a decision link can view its options and aggregate results.

The host close token is returned once when creating a decision and kept in that browser's local storage. The server stores only its SHA-256 hash. Clearing that browser's site data loses the host controls; this demo has no recovery flow.

## Persistence seam and limits

This is a small single-process Node demo with JSON file persistence, not a hosted multi-instance service. It works for sharing links between browsers that can reach the same running server, such as devices on the same network. For internet-wide use, move the decision store to a shared database and serve it over HTTPS. Anonymous deduplication is per browser token, not per human; a guest can vote again from another browser or device. The JSON store has no multi-process locking or backup/restore support. Calendar downloads use the decision's required date and time and assume a one-hour event.

## Scope

Options are manually entered. There is no chat ingestion, contact sync, venue search, payment, account system, or hidden recommendation logic.
