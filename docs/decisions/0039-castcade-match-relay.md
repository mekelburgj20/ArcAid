---
status: accepted
date: 2026-11-12
deciders: owner (re-scope of W8.4, 2026-11-12)
supersedes:
superseded-by:
---

# ArcAid relays Castcade match control messages: in memory, keyed by invite code, paired device required

## Context

A Castcade match is peer-hosted: the host player's companion arbitrates and every other companion connects to it. That
needs a forwarded port on the host's router, which most players cannot or will not set up. The control channel is
small (signed JSON turn messages and WebRTC signalling); the media is WebRTC and finds its own path.

W8.4 as first written keyed a relay room by tournament and checked a roster. The roster (W8.2 `play_mode`, W8.3
invite/accept) is not built. The owner re-scoped W8.4 on 2026-11-12 so hosting without port forwarding does not wait
for it.

Deployment fact this rests on: production is ONE Node process. `docker-compose.prod.yml` runs a single `arcaid`
container behind Caddy (`reverse_proxy arcaid:3001`), with no cluster, no PM2, no replicas and no socket.io adapter.

## Decision

`src/api/matchRelay.ts` adds `match:*` events to the existing socket.io server (default namespace):

- **Auth is a paired Witness device.** The socket connects with `auth: { deviceId, deviceToken }`; the relay checks it
  through `WitnessService.verifyDevice` (the one device-token check) on every `match:host` / `match:join`. JWT and
  anonymous sockets connect and use `join:room` / `join:lobby` / `join:game` exactly as before; they get
  `unauthorized` on any `match:*` event.
- **The room is the match's invite code** (six uppercase letters), owned by the device that hosted it. Another device
  gets `code_in_use`. Knowing the code plus being a paired device is the whole admission test today.
- **The roster seam is `admitJoin(device, code)`** in `MatchRelayOptions`, called after auth and before a socket is
  admitted. When matches become Throwdowns with a roster, that function looks the match up and tests
  `device.canonicalUserId`. Nothing else has to change.
- **Star topology.** `match:relay { data }` from a client reaches the host as `{ from: peer, data }`;
  `match:relay { to: peer, data }` from the host reaches that client as `{ data }`. A client never receives another
  client's frames and is never told another client's peer id. `peer` is a random id, not the device id.
- **`data` is opaque**: a string, at most 256 KB (UTF-8), never parsed, logged or stored. The messages are signed end
  to end by the companions; ArcAid is a carrier, not a party. This is not a result path: scores still arrive through
  the Witness ingest, and nothing relayed can change a board (badge, never gate).
- **Rooms are in memory only.** No table, no migration. A room holds 8 sockets (host + 7), survives a host drop for
  30 s (same device re-emits `match:host` to resume and is sent `match:peer joined` again for each client; client frames
  sent meanwhile are dropped silently), and ends at 12 h. A restart of the process (every deploy) ends
  every live match's control channel; clients see their socket drop and the host re-hosts.
- **Limits.** 200 relayed messages per 10 s per client socket, and per destination peer on the host socket (its
  send-to-all is one emit per client, and all client-to-client signalling passes through it); `match:host` / `match:join` attempts capped per device and per
  IP; 8 `no_such_match` answers in 10 minutes lock the device and the IP out for 15 minutes, so six-letter codes cannot
  be enumerated. `maxHttpBufferSize` is pinned at 1 MB.

## Consequences

- **Easier:** a host needs no port forwarding; the companion reuses the device credential it already holds.
- **Harder:** a deploy during a match drops its control channel (media may survive; the companions must re-host and
  re-join). Match activity is invisible to the room activity log, by design: there is no room and nothing is stored.
- **Locked out:** running ArcAid as more than one process. A second replica would split a room across processes. That
  needs sticky sessions plus a shared room registry (the socket.io Redis adapter covers fan-out, not the ownership and
  grace state held here) and a new ADR.

## Alternatives Considered

- **Wait for the roster (W8.2 / W8.3) and key by tournament** - the original W8.4. Rejected by the re-scope: port
  forwarding blocks every match now, the roster blocks none.
- **A TURN server for the control channel** - the data channel still needs signalling to be set up, so a relay is
  needed either way, and coturn is a second service to run and secure.
- **Persist rooms in SQLite** - survives a restart only if sockets also reconnect and re-identify, which is the same
  re-host the companion does anyway; it would put match metadata in the database for no behaviour gained.
- **Accept unauthenticated sockets that know the code** - the code is six letters; a paired device ties every room and
  every guess to an account, which is what makes the lockout meaningful.
