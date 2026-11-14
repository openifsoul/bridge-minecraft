import { createServer } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import mineflayer from "mineflayer";
import { BridgeRequestError } from "@ifsoul/adapter-sdk/bridge";
import { attachConnector } from "./connector.mjs";
const clean = (code, message) => ({ error: { code, message } });
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function serviceOrigin(value) {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash ||
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))
    )
  )
    throw Error("service");
  return u.origin;
}
export function minecraftSettings(value) {
  if (
    !value ||
    Object.keys(value).some(
      (k) =>
        ![
          "host",
          "port",
          "version",
          "auth",
          "trustedServerApproved",
          "botName",
          "playerName",
        ].includes(k),
    ) ||
    typeof value.host !== "string" ||
    value.host.length > 253 ||
    !/^([A-Za-z0-9][A-Za-z0-9.-]*|\[[a-fA-F0-9:]+\]|[a-fA-F0-9:]+)$/.test(
      value.host,
    ) ||
    !Number.isInteger(value.port) ||
    value.port < 1024 ||
    value.port > 65535 ||
    value.version !== "1.20.2" ||
    value.auth !== "offline" ||
    value.trustedServerApproved !== true ||
    !/^\w{3,16}$/.test(value.botName) ||
    !/^\w{3,16}$/.test(value.playerName) ||
    value.botName === value.playerName
  )
    throw Error("minecraft");
  return structuredClone(value);
}
export async function startCompanion(options = {}) {
  const port = options.port ?? 8811,
    origin = `http://127.0.0.1:${port}`,
    directory = resolve(
      options.directory ??
        process.env.IFSOUL_COMPANION_DATA_DIR ??
        resolve(homedir(), ".ifsoul", "minecraft"),
    );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  let config,
    bot,
    connector,
    phase = "stopped",
    error,
    players = [],
    busy = false,
    epoch = 0;
  try {
    config = JSON.parse(
      await readFile(resolve(directory, "connection.json"), "utf8"),
    );
    if (config.version !== "ifsoul-minecraft-companion/0.4.0")
      throw Error("format");
    minecraftSettings(config.minecraft);
    serviceOrigin(config.serviceEndpoint);
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(config.token) ||
      typeof config.connection?.principalId !== "string"
    )
      throw Error("token");
  } catch (e) {
    if (e.code !== "ENOENT")
      throw Error(
        "Stored companion configuration unsupported; existing file was not changed",
      );
  }
  let authorizedPrincipalId,
    approvedOrigin,
    pairCode = randomBytes(12).toString("base64url"),
    pairExpiry = Date.now() + 300000,
    controlToken,
    controlExpiry = 0,
    attempts = 0;
  const csrf = randomBytes(24).toString("base64url");
  const status = () => ({
    configured: !!config,
    running: !!bot,
    phase,
    ...(error ? { error } : {}),
    ...(config
      ? {
          config: {
            minecraft: config.minecraft,
            serviceEndpoint: config.serviceEndpoint,
            connection: config.connection,
          },
        }
      : {}),
    ...(connector ? { connector: connector.status() } : {}),
    players,
  });
  const browserStatus = () => {
    if (config && config.serviceEndpoint !== approvedOrigin)
      return {
        configured: true,
        running: !!bot,
        phase: "other-service",
        requiresServiceSwitch: true,
      };
    if (config && config.connection.principalId !== authorizedPrincipalId)
      return {
        configured: true,
        running: !!bot,
        phase: "other-owner",
        requiresOwnerSwitch: true,
      };
    return status();
  };
  async function persist() {
    const tmp = resolve(directory, "connection.tmp");
    await writeFile(tmp, JSON.stringify(config), { mode: 0o600 });
    await rename(tmp, resolve(directory, "connection.json"));
    await chmod(resolve(directory, "connection.json"), 0o600);
  }
  async function remote(path, body, credential = config?.token) {
    const endpoint = serviceOrigin(config.serviceEndpoint);
    const response = await fetch(endpoint + "/api/game/device/" + path, {
      method: "POST",
      redirect: "error",
      signal:
        path === "ready" || path === "dialogue"
          ? AbortSignal.any([
              activeRequest.signal,
              AbortSignal.timeout(path === "dialogue" ? 65000 : 10000),
            ])
          : AbortSignal.timeout(10000),
      headers: {
        "content-type": "application/json",
        ...(options.hostSecret && endpoint === options.desktopOrigin
          ? { "x-ifsoul-desktop": options.hostSecret }
          : {}),
        ...(credential ? { authorization: "Bearer " + credential } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw Error(
        response.status === 402
          ? "balance"
          : response.status === 401 || response.status === 403
            ? "authorization"
            : "service",
      );
    const reader = response.body?.getReader();
    if (!reader) throw Error("response");
    let size = 0;
    const chunks = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 32768) {
          await reader.cancel();
          throw Error("response");
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  let activeRequest = new AbortController();
  function stop() {
    activeRequest.abort();
    activeRequest = new AbortController();
    epoch++;
    connector?.stop();
    connector = undefined;
    bot?.quit("IfSoul companion stopped");
    bot = undefined;
    players = [];
    phase = "stopped";
  }
  async function start() {
    if (!config) throw Error("configure");
    stop();
    const generation = epoch;
    phase = "connecting";
    error = undefined;
    const current = options.createBot
      ? options.createBot(config.minecraft)
      : mineflayer.createBot({
          host: config.minecraft.host,
          port: config.minecraft.port,
          version: "1.20.2",
          auth: "offline",
          username: config.minecraft.botName,
          hideErrors: true,
        });
    bot = current;
    current.on("error", () => {
      if (generation !== epoch) return;
      error =
        "Minecraft connection failed. Check the server address, supported version and offline trust mode.";
      phase = "error";
    });
    current.on("kicked", () => {
      if (generation !== epoch) return;
      error =
        "Minecraft rejected the connection. Check server permissions, authentication mode and version.";
      phase = "error";
    });
    current.on("end", () => {
      if (generation !== epoch) return;
      connector?.stop();
      bot = undefined;
      phase = "stopped";
    });
    current.once("spawn", () => {
      void (async () => {
        phase = "waiting-player";
        for (let i = 0; i < 30 && generation === epoch; i++) {
          players = Object.values(current.players ?? {})
            .filter((p) => p.username !== current.username && p.uuid)
            .map((p) => ({ name: p.username, uuid: p.uuid }));
          const player = players.find(
            (p) => p.name === config.minecraft.playerName,
          );
          if (player) {
            const ready = await remote("ready", { player });
            if (generation !== epoch) return;
            config.connection = ready.connection;
            await persist();
            const cfg = {
              playerName: player.name,
              playerUuid: player.uuid,
              worldId: config.connection.hostId,
              memoryId: config.connection.memoryId,
              character: config.connection.character,
              deadlineMs: 60000,
              cooldownMs: 1500,
              maxCalls: 10,
              historyConsent: (allowed) => {
                if (generation !== epoch) return Promise.reject(Error("stale"));
                return remote("history-consent", { allowed });
              },
            };
            connector = attachConnector(
              current,
              cfg,
              async (request) => {
                if (generation !== epoch) throw Error("stale");
                let reply;
                try {
                  reply = await remote("dialogue", {
                    requestId: request.requestId,
                    text: request.context,
                  });
                } catch {
                  throw new BridgeRequestError();
                }
                if (generation !== epoch) throw Error("stale");
                return reply;
              },
              (event) => {
                if (
                  event.event === "request-failed" ||
                  (event.event === "invalidated" &&
                    ["fallback", "request-failed", "deadline"].includes(
                      event.reason,
                    ))
                ) {
                  error =
                    "Service reply unavailable. Check connection permissions, model readiness or managed balance, then reconnect.";
                  phase = "error";
                }
                if (
                  event.event === "invalidated" &&
                  ![
                    "spawn",
                    "stop",
                    "fallback",
                    "request-failed",
                    "deadline",
                  ].includes(event.reason)
                ) {
                  phase =
                    event.reason === "recipient-left"
                      ? "waiting-player"
                      : "error";
                  error =
                    "The game session changed. Check that the selected player is online, then reconnect.";
                }
                if (event.event === "ready") {
                  phase = "ready";
                  error = undefined;
                }
              },
            );
            connector.start();
            return;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        if (generation === epoch) {
          error =
            "The selected player is not online. Join the server and reconnect.";
          phase = "waiting-player";
        }
      })().catch(() => {
        if (generation === epoch) {
          error =
            "Service authorization or readiness failed. Re-pair this connection or check the service.";
          phase = "error";
        }
      });
    });
  }
  function approve(appOrigin) {
    const nextOrigin = serviceOrigin(appOrigin);
    stop();
    approvedOrigin = nextOrigin;
    authorizedPrincipalId = undefined;
    pairCode = randomBytes(12).toString("base64url");
    pairExpiry = Date.now() + 300000;
    controlToken = undefined;
    attempts = 0;
    return pairCode;
  }
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    );
    const path = new URL(req.url ?? "/", origin).pathname;
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (
        req.headers.host !== `127.0.0.1:${port}` ||
        (options.hostSecret &&
          !same(req.headers["x-ifsoul-desktop"], options.hostSecret))
      )
        return reply(
          403,
          clean("forbidden", "Open the companion at its loopback address."),
        );
      const nonce = req.headers["x-ifsoul-desktop-nonce"];
      if (
        options.responseKey &&
        typeof nonce === "string" &&
        /^[a-zA-Z0-9_-]{32}$/.test(nonce)
      )
        res.setHeader(
          "X-IfSoul-Desktop-Proof",
          createHmac("sha256", options.responseKey)
            .update(nonce)
            .digest("base64url"),
        );
      if (!options.hostSecret && req.method === "GET" && path === "/") {
        if (req.headers.origin && req.headers.origin !== origin)
          return reply(403, clean("forbidden", "Open the companion directly."));
        res.setHeader("Content-Type", "text/html");
        res.end(
          `<!doctype html><html><meta name="viewport" content="width=device-width"><title>IfSoul Minecraft companion</title><body style="font:18px system-ui;max-width:42rem;margin:3rem auto;padding:1rem"><h1>Minecraft companion</h1><p>Approve only the IfSoul App address you opened yourself. This allows that App to configure one private-dialogue bridge on this computer. Approval pauses an existing local connection; reconnect after verification.</p><form action="/consent" method="post"><input name="csrf" type="hidden" value="${csrf}"><label>IfSoul App origin <input name="appOrigin" type="url" required placeholder="http://127.0.0.1:8788"></label><button>Approve App and show pairing code</button></form>${approvedOrigin ? `<p>Approved: <strong>${approvedOrigin.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;")}</strong></p><p>Single-use pairing code (5 minutes): <strong>${pairCode}</strong></p>` : ""}<p>No provider keys are needed here. Stop the companion with Ctrl-C.</p></body></html>`,
        );
        return;
      }
      const requestOrigin = req.headers.origin;
      if (req.method === "OPTIONS") {
        if (requestOrigin !== approvedOrigin)
          return reply(
            403,
            clean("forbidden", "Approve this App locally first."),
          );
        res.writeHead(204, {
          "Access-Control-Allow-Origin": approvedOrigin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Allow-Private-Network": "true",
          Vary: "Origin",
        });
        res.end();
        return;
      }
      let size = 0,
        chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) {
          return reply(413, clean("too-large", "Configuration is too large."));
        }
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      if (!options.hostSecret && req.method === "POST" && path === "/consent") {
        if (
          requestOrigin !== origin ||
          !req.headers["content-type"]?.startsWith(
            "application/x-www-form-urlencoded",
          )
        )
          return reply(
            403,
            clean("forbidden", "Approve from the companion page."),
          );
        const fields = new URLSearchParams(text);
        if (!same(fields.get("csrf"), csrf))
          return reply(403, clean("forbidden", "Reload the companion page."));
        approve(fields.get("appOrigin"));
        res.writeHead(303, { Location: "/" });
        res.end();
        return;
      }
      if (requestOrigin !== approvedOrigin || !approvedOrigin)
        return reply(
          403,
          clean("forbidden", "Approve this App on the companion page first."),
        );
      res.setHeader("Access-Control-Allow-Origin", approvedOrigin);
      res.setHeader("Vary", "Origin");
      const body = req.method === "POST" ? JSON.parse(text || "{}") : {};
      if (req.method === "POST" && path === "/pair") {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          return reply(400, clean("invalid", "Use JSON pairing."));
        if (
          ++attempts > 8 ||
          Date.now() > pairExpiry ||
          !same(body.code, pairCode)
        )
          return reply(
            403,
            clean(
              "pairing",
              "Pairing code expired or incorrect. Approve the App again locally.",
            ),
          );
        pairCode = "";
        controlToken = randomBytes(32).toString("base64url");
        controlExpiry = Date.now() + 900000;
        authorizedPrincipalId = undefined;
        const issuedToken = controlToken,
          issuedExpiry = controlExpiry,
          pairOrigin = approvedOrigin;
        if (
          config &&
          config.serviceEndpoint === approvedOrigin &&
          typeof body.ownerProof === "string"
        ) {
          try {
            const proof = await remote("owner-proof", {
              code: body.ownerProof,
              connectionId: config.connection.connectionId,
            });
            if (
              controlToken === issuedToken &&
              approvedOrigin === pairOrigin &&
              proof.authorized === true &&
              proof.connection?.principalId === config.connection.principalId
            )
              authorizedPrincipalId = proof.connection.principalId;
          } catch {
            /* No private metadata or resume permission without owner proof. */
          }
        }

        if (controlToken !== issuedToken || approvedOrigin !== pairOrigin)
          return reply(
            403,
            clean("pairing", "Local approval changed. Pair again."),
          );
        return reply(200, {
          controlToken: issuedToken,
          expiresAt: issuedExpiry,
        });
      }
      if (
        !controlToken ||
        Date.now() > controlExpiry ||
        !same(req.headers.authorization, "Bearer " + controlToken)
      )
        return reply(403, clean("pairing", "Pair with the companion again."));
      if (req.method === "GET" && path === "/status")
        return reply(200, browserStatus());
      if (
        req.method !== "POST" ||
        !req.headers["content-type"]?.startsWith("application/json")
      )
        return reply(
          400,
          clean("invalid", "Use an approved configuration action."),
        );
      if (
        config &&
        (config.serviceEndpoint !== approvedOrigin ||
          config.connection.principalId !== authorizedPrincipalId) &&
        !["/clear", "/configure"].includes(path)
      )
        return reply(
          409,
          clean(
            "other-service",
            "Clear the previous local connection before using this App.",
          ),
        );
      if (busy)
        return reply(
          409,
          clean("busy", "Wait for the current connection action."),
        );
      busy = true;
      const actionControlToken = controlToken,
        actionOrigin = approvedOrigin;
      try {
        if (path === "/configure") {
          if (config && config.serviceEndpoint !== approvedOrigin)
            throw Error("clear-first");
          if (
            Object.keys(body).some(
              (k) => !["serviceEndpoint", "pairCode", "minecraft"].includes(k),
            )
          )
            throw Error("configuration");
          const endpoint = serviceOrigin(body.serviceEndpoint),
            minecraft = minecraftSettings(body.minecraft);
          if (endpoint !== approvedOrigin) throw Error("service-origin");
          stop();
          const previous = config;
          config = {
            version: "ifsoul-minecraft-companion/0.4.0",
            serviceEndpoint: endpoint,
            minecraft,
          };
          try {
            const grant = await remote(
              "redeem",
              { code: body.pairCode },
              undefined,
            );
            if (
              controlToken !== actionControlToken ||
              approvedOrigin !== actionOrigin ||
              Date.now() > controlExpiry
            ) {
              try {
                await remote("revoke", {}, grant.token);
              } catch {}
              throw Error("stale-control");
            }
            if (
              typeof grant.token !== "string" ||
              !/^[A-Za-z0-9_-]{43}$/.test(grant.token) ||
              typeof grant.connection?.principalId !== "string"
            )
              throw Error("grant");
            if (
              previous &&
              previous.connection.principalId !== grant.connection.principalId
            ) {
              try {
                await remote("revoke", {}, grant.token);
              } catch {}
              throw Error("clear-owner-first");
            }
            config = {
              ...config,
              token: grant.token,
              connection: grant.connection,
            };
            if (previous?.token)
              try {
                await remote("revoke", {}, previous.token);
              } catch {}
            authorizedPrincipalId = grant.connection.principalId;
            await persist();
          } catch (e) {
            config = previous;
            throw e;
          }
          phase = "configured";
          error = undefined;
        } else if (path === "/start" || path === "/reconnect") await start();
        else if (path === "/stop") stop();
        else if (path === "/clear") {
          if (body.consent !== true) throw Error("consent");
          stop();
          let revoked = true;
          if (config?.token)
            try {
              await remote("revoke", {});
            } catch {
              revoked = false;
            }
          config = undefined;
          if (!revoked)
            error =
              "Local connection cleared. Open the previous App to revoke its service grant; remote confirmation was unavailable.";
          const { rm } = await import("node:fs/promises");
          await rm(resolve(directory, "connection.json"), { force: true });
        } else
          return reply(404, clean("not-found", "Unknown companion action."));
        return reply(200, browserStatus());
      } finally {
        busy = false;
      }
    } catch {
      reply(
        400,
        clean(
          "configuration",
          "Could not connect. Check the approved service, Minecraft address/version, permissions and pairing code.",
        ),
      );
    }
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", accept);
  });
  return {
    origin,
    ...(options.hostSecret ? { approve } : {}),
    status,
    stop: async () => {
      stop();
      await new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      });
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const companion = await startCompanion();
  console.log(
    `Open ${companion.origin} to approve your App and pair. No code or credentials are logged.`,
  );
  const stop = () => {
    void companion.stop().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
