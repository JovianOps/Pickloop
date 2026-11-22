# PickLoop

PickLoop helps groups choose a plan with anonymous ranked ballots. It has no accounts or external services.

## Run locally

Requires Node.js 18 or newer. No dependencies need installing.

```sh
npm start
```

Open <http://localhost:3000>. By default the app listens only on this computer. To let devices on your local network reach it, start with `HOST=0.0.0.0` and `PORT=3000` set in the environment, then open PickLoop from this computer using its LAN address (for example, `http://192.168.1.20:3000`) so generated invite links use that address. This exposes the app on the network without TLS; share only with people you trust. It is not deployed or internet-accessible by default.

Each decision link expires after 30 days. Guests can see options and details, but aggregate scores stay private until the host reveals them or closes voting. Event date/time and voting deadline are interpreted in the host browser's selected time zone. A deadline closes voting on the first request at or after that time. Guests can revise their ballot until then.

## Host recovery

After creating a decision, save the private recovery link somewhere safe and acknowledge the prompt to unlock host controls. Anyone with that link can manage the decision. It is shown once; the host can rotate it to invalidate the previous link. It is separate from the guest invite and is never included in invite text.

## Data and calendar

Decision data is stored in `data/decisions.json` with an atomic replacement and previous-version `.bak` file. Expired decision content is removed during startup and subsequent API requests; short-lived expired-link records preserve a clear 410 response. `/healthz` checks the local storage path. Set `PICKLOOP_DATA_FILE` to store the JSON file elsewhere.

The store is for one local Node process; it has no cross-process locking, hosted database, or backup service. Recovery links are capability secrets, not user accounts, and anonymous vote deduplication is per browser token, not per person. Losing the recovery link means losing host control.

The downloadable `.ics` event uses UTC timestamps, records the host's IANA time zone for context, and uses the selected event duration. Calendar clients display UTC events in each attendee's local time.

## Tests and scope

Run the integration and storage checks with:

```sh
npm test
```

Options are manually curated. There is no chat ingestion, contact sync, venue search, payment, account system, native app, or hidden AI choice.
