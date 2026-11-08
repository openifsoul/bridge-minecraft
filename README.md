# Experimental Minecraft player bridge

Experimental IfSoul 0.3.0 bridge. Source, deterministic native safety and one bounded two-call Ollama dialogue/recall run were independently reviewed on the tested tuple below. One Mineflayer player
client answers one explicitly selected player through private whispers. No movement,
combat, pathfinding, NPC spawning, voice or public chat. A bot is a separate player
connection.

Node 22.18–24, pnpm 10.15.0; pinned Mineflayer 4.39.0 and vendored public SDK archive.
Use a standalone checkout:

```sh
git clone https://github.com/openifsoul/bridge-minecraft.git
cd bridge-minecraft
pnpm install --frozen-lockfile
pnpm check
```

No private imports,
IfSoul account, registry SDK package or sibling runtime checkout is needed. SDK 0.3.0 is vendored with a SHA256/source-inventory receipt; the common release is IfSoul 0.3.0. The coordinated current release metadata is checked locally; no npm publication is configured.

## First loopback test

The candidate tuple is macOS arm64, Node 22.18.0, Mineflayer 4.39.0 and vanilla Java
Minecraft 1.20.2. Repeated native deterministic safety checks and one real-model dialogue/recall test passed on this tuple; this establishes only the bounded tested tuple. Never modify an existing
installation, profile, world, account or global Java/system settings. The CLI does not download servers, JDKs or models, accept the EULA or invoke a launcher.

Before a native test, owner approval must establish a new disposable loopback
server, its Minecraft EULA acceptance, a compatible Java runtime and explicitly
isolated offline-test trust choice. Offline UUIDs/usernames authenticate no account
or IfSoul owner; this CLI intentionally rejects public endpoints and only supports
that isolated test. Microsoft-authenticated remote servers require a future reviewed
composition, not changing this server's authentication to fit the bot.

**Every game client must be silent from initial launch.** Create a task-owned new
game directory/profile and verify `soundCategory_master:0.0` in its own options.txt
before launch. Do not change system volume or existing profiles. If first-start
silence cannot be guaranteed, do not launch. Mineflayer itself produces no audio.
A headless server does not need a graphical game client. Close task-owned processes
and retain/delete disposable data only according to the agreed test policy.

Copy config.example.json to ignored config.local.json. Select the agreed server
port, consenting player's exact server UUID/name and an original character. A name
is checked against the current server player UUID on every request and send. This
assumes a trusted isolated server and its private-whisper parser; untrusted server
plugins can spoof messages and are outside this trust boundary. Set explicit
isolatedOfflineServerApproved only after that choice is approved. Start with
`pnpm start -- config.local.json`; stop with Ctrl-C. Wait for ready, then the selected
player sends `/tell TaviBot hello`. Public chat and unrelated whispers are ignored.
No automatic reconnect/retry/replay: restart manually after inspecting disconnect.
Death/dimension/recipient departure invalidate work; a new playable spawn is needed.

For App mode separately start the public self-host App per its README, create/select
a character memory and configure an installed Ollama model. Set mode to app and
add app `http://127.0.0.1:8788` (or an explicitly selected loopback port), provider `ollama`, model with the exact installed name.
Keep the same memoryId across manual restart. This only selects App-owned memory;
durable event recall must be independently verified for each claimed setup. The local candidate retained a synthetic player-reported event across bot reconnect and an App/SQLite restart; this does not verify that a reported physical game event occurred. No local conversation log is
written, and receipts contain event IDs/status only. Provider/model calls are
bounded by maxCalls (1–10), one in-flight call, queue size two, cooldown and deadline. For a deadline above 60000 ms (maximum 150000), configure bridgeLimits.timeoutMs to exactly the same value and use a compatible explicit App/provider resource policy; HTTP capabilities must approve the request.
Coordinate model time with other work; a timeout does not prove remote inference
has stopped. Do not start another model batch while one may still run.

Output is single-line, <=180 characters, without control/format characters or a
leading slash. A send-accepted receipt means local API acceptance, not delivery or
reading. SDK observations are retained only in a bounded in-process history; App
may persist authorized request history according to its own policy. Restart does
not replay uncertain sends. A local candidate App/native run observed two real qwen3:8b replies, including recall after bot and App restart. Latencies were about 17s and 8s; these are measured samples, not a latency guarantee. Source and bounded receipts were independently reviewed; this does not establish general model reliability.

## Troubleshooting and proof still required

No ready: check loopback endpoint/version, EULA, Java and server permission; never
inspect launcher account/token files. No reply: verify exact UUID/name, private
whisper syntax, cooldown/call cap, model readiness and deadline. Unsafe/long model
output is rejected. App errors can produce SDK fallback; the connector suppresses it and invalidates the session. Inspect the receipt before a manual restart. The CLI does not reconnect automatically.

Fixtures are separate from a native test. Candidate evidence covers exact server spawn/private exchange, death/dimension/kick/restart, an ignored-cancellation timeout, and a two-call real-model conversation with synthetic reported-event recall across App restart. Independent review covers this source and bounded evidence, without expanding the tested scope. A later
fresh Windows/friend-PC run is required before a cross-platform onboarding claim.
No existing TLauncher/modpack compatibility has been verified.

Primary API checked against the pinned release:
https://github.com/PrismarineJS/mineflayer/blob/4.39.0/docs/api.md
and its Node >=22 manifest. Source pinning is not runtime compatibility proof.

## Repeatable native safety check

The opt-in harness uses an **already prepared and approved disposable** vanilla
1.20.2 server directory; it never downloads files or accepts the EULA. It verifies
loopback/offline/owned-world properties and refuses an occupied port. Example:

```sh
IFSOUL_TEST_SERVER_DIR=/absolute/path/to/disposable-server \
IFSOUL_DISPOSABLE_TEST_APPROVED=yes node scripts/native-safety.mjs
```

It owns that server process and two synthetic protocol clients, exercises actual
death, dimension transfer, kick, manual reconnect and ignored-cancellation timeout,
then closes its clients and server. It prints no dialogue, credentials or raw
packets. Expected result: passed, six transport calls, two observed private
replies, no queued requests. A narrow EPIPE classification is permitted only for
the kicked bot after its matching deliberate kick and before actual end; other
errors fail. Repeated checks choose a different actual dimension without deleting
saved player/world state. These headless protocol clients produce no sound.

The native safety check passed on the stated macOS tuple, and independent source/evidence review passed. The separate App/LLM proof is described above; this harness itself is deterministic and makes no general model, human-client or Windows claim.
