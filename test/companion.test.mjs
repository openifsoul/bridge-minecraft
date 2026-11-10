import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import {
  startCompanion,
  minecraftSettings,
  serviceOrigin,
} from "../src/companion.mjs";
const minecraft = {
  host: "127.0.0.1",
  port: 25565,
  version: "1.20.2",
  auth: "offline",
  trustedServerApproved: true,
  botName: "LumenBot",
  playerName: "Tester",
};
const headers = (origin, token) => ({
  origin,
  "content-type": "application/json",
  ...(token ? { authorization: "Bearer " + token } : {}),
});
test("companion requires local consent, exact Host/Origin, single-use code, scoped control and private persisted credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ifsoul-companion-"));
  let companion, service;
  const nativeRequests = [];
  let bot;
  try {
    service = createServer(async (req, res) => {
      let text = "";
      for await (const c of req) text += c;
      nativeRequests.push({
        origin: req.headers.origin,
        cookie: req.headers.cookie,
        path: req.url,
        body: JSON.parse(text),
      });
      if (
        req.url.endsWith("owner-proof") &&
        JSON.parse(text).code !== "same-owner-proof"
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (req.url.endsWith("dialogue")) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          req.url.endsWith("redeem")
            ? {
                token: "a".repeat(43),
                connection: {
                  principalId: "owner",
                  connectionId: "connection",
                  hostId: "server-generated",
                  memoryId: "owned-memory",
                  character: {
                    id: "owned-profile",
                    name: "Lumen",
                    temperament: "Calm",
                  },
                },
              }
            : {
                authorized: req.url.endsWith("owner-proof") ? true : undefined,
                connection: {
                  principalId: "owner",
                  connectionId: "connection",
                  hostId: "server-generated",
                  memoryId: "owned-memory",
                  character: {
                    id: "owned-profile",
                    name: "Lumen",
                    temperament: "Calm",
                  },
                },
              },
        ),
      );
    });
    await new Promise((r) => service.listen(0, "127.0.0.1", r));
    const app = `http://127.0.0.1:${service.address().port}`;
    companion = await startCompanion({
      port: 18811,
      directory,
      createBot: () => {
        bot = new EventEmitter();
        bot.username = "LumenBot";
        bot.player = { uuid: "bot" };
        bot.players = {
          Tester: {
            username: "Tester",
            uuid: "11111111-1111-1111-1111-111111111111",
          },
        };
        bot.game = { dimension: "overworld" };
        bot.quit = () => bot.emit("end");
        bot.whisper = () => {};
        return bot;
      },
    });
    const base = companion.origin;
    assert.equal(
      await new Promise((resolve, reject) => {
        const req = get(base, { headers: { host: "evil.invalid" } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on("error", reject);
      }),
      403,
    );
    assert.equal(
      (await fetch(base + "/status", { headers: { origin: app } })).status,
      403,
    );
    const html = await (await fetch(base)).text(),
      csrf = html.match(/name="csrf" type="hidden" value="([^"]+)"/)[1];
    assert.equal(
      (
        await fetch(base + "/consent", {
          method: "POST",
          redirect: "manual",
          headers: {
            origin: base,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ csrf: "wrong", appOrigin: app }),
        })
      ).status,
      403,
    );
    const consent = async (origin) =>
      fetch(base + "/consent", {
        method: "POST",
        redirect: "manual",
        headers: {
          origin: base,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ csrf, appOrigin: origin }),
      });
    assert.equal((await consent(app)).status, 303);
    let page = await (await fetch(base)).text(),
      code = page.match(/Single-use pairing code[^<]*<strong>([^<]+)</)[1];
    const pair = await (
      await fetch(base + "/pair", {
        method: "POST",
        headers: headers(app),
        body: JSON.stringify({ code }),
      })
    ).json();
    assert(pair.controlToken);
    assert.equal(
      (
        await fetch(base + "/pair", {
          method: "POST",
          headers: headers(app),
          body: JSON.stringify({ code }),
        })
      ).status,
      403,
    );
    const post = (path, body = {}) =>
      fetch(base + path, {
        method: "POST",
        headers: headers(app, pair.controlToken),
        body: JSON.stringify(body),
      });
    assert.equal(
      (
        await post("/configure", {
          serviceEndpoint: app,
          pairCode: "b".repeat(24),
          minecraft,
        })
      ).status,
      200,
    );
    assert.equal(nativeRequests[0].origin, undefined);
    assert.equal(nativeRequests[0].cookie, undefined);
    assert.equal(
      (await stat(join(directory, "connection.json"))).mode & 0o777,
      0o600,
    );
    assert(
      (await readFile(join(directory, "connection.json"), "utf8")).includes(
        "a".repeat(43),
      ),
    );
    const status = await (
      await fetch(base + "/status", {
        headers: headers(app, pair.controlToken),
      })
    ).json();
    assert.equal(status.config.connection.memoryId, "owned-memory");
    assert(!JSON.stringify(status).includes("a".repeat(43)));
    assert.equal(
      (
        await fetch(base + "/status", {
          headers: headers("https://evil.invalid", pair.controlToken),
        })
      ).status,
      403,
    );
    assert.equal((await post("/start")).status, 200);
    bot.emit("spawn");
    for (let i = 0; i < 20 && companion.status().phase !== "ready"; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(companion.status().phase, "ready");
    assert.equal(
      nativeRequests.at(-1).body.player.uuid,
      bot.players.Tester.uuid,
    );
    bot.emit("whisper", "Tester", "This denied request must not look ready");
    for (let i = 0; i < 30 && companion.status().phase !== "error"; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(companion.status().phase, "error");
    assert.match(companion.status().error, /balance|permissions/);
    assert.equal(companion.status().connector.ready, false);
    bot.emit("playerLeft",{uuid:bot.players.Tester.uuid});assert.equal(companion.status().phase,"waiting-player");assert.match(companion.status().error,/selected player/);
    await post("/stop");
    assert.equal(companion.status().running, false);
    await consent(app);
    page = await (await fetch(base)).text();
    code = page.match(/Single-use pairing code[^<]*<strong>([^<]+)</)[1];
    const foreignPair = await (
      await fetch(base + "/pair", {
        method: "POST",
        headers: headers(app),
        body: JSON.stringify({ code, ownerProof: "foreign-owner-proof" }),
      })
    ).json();
    const hidden = await (
      await fetch(base + "/status", {
        headers: headers(app, foreignPair.controlToken),
      })
    ).json();
    assert.equal(hidden.requiresOwnerSwitch, true);
    assert(!JSON.stringify(hidden).includes("owned-memory"));
    assert(!JSON.stringify(hidden).includes("server-generated"));
    assert.equal(
      (
        await fetch(base + "/start", {
          method: "POST",
          headers: headers(app, foreignPair.controlToken),
          body: "{}",
        })
      ).status,
      409,
    );
    await consent(app);
    page = await (await fetch(base)).text();
    code = page.match(/Single-use pairing code[^<]*<strong>([^<]+)</)[1];
    const ownerPair = await (
      await fetch(base + "/pair", {
        method: "POST",
        headers: headers(app),
        body: JSON.stringify({ code, ownerProof: "same-owner-proof" }),
      })
    ).json();
    const restored = await (
      await fetch(base + "/status", {
        headers: headers(app, ownerPair.controlToken),
      })
    ).json();
    assert.equal(restored.config.connection.memoryId, "owned-memory");
    await consent("https://new-app.example");
    page = await (await fetch(base)).text();
    code = page.match(/Single-use pairing code[^<]*<strong>([^<]+)</)[1];
    const next = await (
      await fetch(base + "/pair", {
        method: "POST",
        headers: headers("https://new-app.example"),
        body: JSON.stringify({ code }),
      })
    ).json();
    const redacted = await (
      await fetch(base + "/status", {
        headers: headers("https://new-app.example", next.controlToken),
      })
    ).json();
    assert(redacted.requiresServiceSwitch);
    assert(!JSON.stringify(redacted).includes("owned-memory"));
    assert.equal(
      (
        await fetch(base + "/clear", {
          method: "POST",
          headers: headers("https://new-app.example", next.controlToken),
          body: "{}",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(base + "/clear", {
          method: "POST",
          headers: headers("https://new-app.example", next.controlToken),
          body: '{"consent":true}',
        })
      ).status,
      200,
    );
  } finally {
    await companion?.stop();
    if (service) await new Promise((r) => service.close(r));
    await rm(directory, { recursive: true, force: true });
  }
});
test("endpoint and Minecraft validators reject ambient URLs, auth/version changes and nonconsensual configuration", () => {
  assert.equal(serviceOrigin("https://owned.example"), "https://owned.example");
  for (const url of [
    "http://owned.example",
    "https://user:pass@owned.example",
    "https://owned.example/path",
    "file:///etc/passwd",
  ])
    assert.throws(() => serviceOrigin(url));
  for (const change of [
    { auth: "microsoft" },
    { version: "1.20.4" },
    { trustedServerApproved: false },
    { host: "http://localhost" },
    { port: 22 },
    { botName: "Tester" },
  ])
    assert.throws(() => minecraftSettings({ ...minecraft, ...change }));
});
