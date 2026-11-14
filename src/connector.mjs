import { randomUUID } from "node:crypto";
import { createGameBridge } from "@ifsoul/adapter-sdk/bridge";
export function attachConnector(bot, config, transport, receipt = () => {}) {
  let epoch = 0,
    bridge,
    controller,
    ready = false,
    stopped = false,
    active = false;
  let lastAccepted = -Infinity,
    calls = 0,
    dimension;
  let updatingConsent = false;
  const queue = [],
    history = [],
    listeners = [];
  const record = (event, data = {}) => receipt({ event, epoch, ...data });
  const on = (name, fn) => {
    bot.on(name, fn);
    listeners.push([name, fn]);
  };
  const invalidate = (reason) => {
    epoch++;
    ready = false;
    queue.length = 0;
    controller?.abort();
    bridge?.dispose();
    bridge = undefined;
    record("invalidated", { reason });
  };
  const binding = (name) =>
    name === config.playerName &&
    name !== bot.username &&
    bot.players?.[name]?.uuid === config.playerUuid;
  async function drain() {
    if (active || stopped) return;
    active = true;
    try {
      while (ready && queue.length) {
        const item = queue.shift(),
          current = bridge;
        if (
          item.epoch !== epoch ||
          Date.now() >= item.deadline ||
          !binding(item.name)
        )
          continue;
        let timer;
        try {
          calls++;
          const reply = await Promise.race([
            current.chat(item.message),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(Error("deadline")),
                item.deadline - Date.now(),
              );
            }),
          ]);
          if (
            !ready ||
            stopped ||
            item.epoch !== epoch ||
            Date.now() >= item.deadline ||
            !binding(item.name)
          ) {
            record("dropped", { reason: "stale" });
            if (item.epoch === epoch && Date.now() >= item.deadline)
              invalidate("deadline");
            continue;
          }
          if (reply.source === "fallback") {
            invalidate("fallback");
            continue;
          }
          const text = reply.speech;
          if (
            typeof text !== "string" ||
            !text.trim() ||
            text.length > 180 ||
            /^\s*\//u.test(text) ||
            /[\p{Cc}\p{Cf}§]/u.test(text)
          ) {
            record("dropped", { reason: "unsafe-output" });
            continue;
          }
          bot.whisper(item.name, text);
          current.report({
            id: randomUUID(),
            summary:
              "Host accepted a private reply send; delivery and reading unknown.",
            kind: "outcome",
            actor: "agent",
            observer: "host",
            recipient: "user",
          });
          record("send-accepted", { request: item.id, source: reply.source });
        } catch {
          record("request-failed", { request: item.id });
          if (item.epoch === epoch) invalidate("request-failed");
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      active = false;
      if (ready && queue.length) void drain();
    }
  }
  const activate = () => {
    invalidate("spawn");
    if (stopped || !bot.player?.uuid || bot.player.uuid === config.playerUuid)
      return;
    controller = new AbortController();
    ready = true;
    bridge = createGameBridge({
      hostId: config.worldId,
      memoryId: config.memoryId,
      character: config.character,
      signal: controller.signal,
      requestTimeoutMs: config.deadlineMs,
      limits: config.bridgeLimits,
      transport,
      history: () => history,
      onObservation: (event) => {
        history.push(event);
        if (history.length > 12) history.shift();
      },
      onSpeech: () => {},
    });
    record("ready");
  };
  on("spawn", activate);
  for (const event of ["death", "respawn", "end", "kicked", "error"])
    on(event, () => invalidate(event));
  on("game", () => {
    const next = bot.game?.dimension;
    if (dimension !== undefined && dimension !== next) invalidate("dimension");
    dimension = next;
  });
  on("playerLeft", (player) => {
    if (player.uuid === config.playerUuid) invalidate("recipient-left");
  });
  on("whisper", (name, message) => {
    if (
      !ready ||
      stopped ||
      !binding(name) ||
      typeof message !== "string" ||
      !message.trim() ||
      message.length > 500 ||
      /[\p{Cc}\p{Cf}]/u.test(message)
    )
      return;
    const consent =
      message === "!ifsoul allow-history"
        ? true
        : message === "!ifsoul deny-history"
          ? false
          : undefined;
    if (consent !== undefined && config.historyConsent) {
      if (updatingConsent) return;
      updatingConsent = true;
      const consentEpoch = epoch;
      void config
        .historyConsent(consent)
        .then(
          () => {
            if (ready && !stopped && epoch === consentEpoch && binding(name))
              bot.whisper(
                name,
                consent
                  ? "App owner history inspection enabled for this connection."
                  : "App owner history inspection disabled for this connection.",
              );
          },
          () => {
            if (ready && !stopped && epoch === consentEpoch && binding(name))
              bot.whisper(name, "The history permission could not be changed.");
          },
        )
        .finally(() => {
          updatingConsent = false;
        });
      return;
    }
    if (
      calls + queue.length >= config.maxCalls ||
      Date.now() - lastAccepted < config.cooldownMs ||
      queue.length >= 2
    ) {
      record("rejected", { reason: "budget" });
      return;
    }
    lastAccepted = Date.now();
    queue.push({
      id: randomUUID(),
      epoch,
      name,
      message,
      deadline: Date.now() + config.deadlineMs,
    });
    void drain();
  });
  return {
    start() {
      activate();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      invalidate("stop");
      for (const [name, fn] of listeners) bot.removeListener(name, fn);
    },
    status() {
      return { epoch, ready, queued: queue.length, active, calls };
    },
  };
}
