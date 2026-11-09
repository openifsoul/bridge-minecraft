# Setup reference

Install the pinned Node/pnpm versions and run the README's frozen install/check
commands. Use a permitted loopback Java server with a compatible Java runtime and
follow Minecraft server terms. Keep launcher credentials and existing profiles,
worlds and server authentication separate from this connector's configuration.

Configure the selected player's exact server UUID/name and an original character.
Start in deterministic scenario mode. For App mode, start the public App on
loopback, configure an installed model and select the returned profile/memory IDs.
Provider/model selection and token/context/deadline limits belong to App.

Keep the same memoryId when reconnecting to use the same App memory. The bridge
requires explicit permitted whisper configuration and does not infer identity from
a display name. Store config.local.json outside version control and stop the bridge
with Ctrl-C before changing the connection configuration.
