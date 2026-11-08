import { readFile } from 'node:fs/promises';
import mineflayer from 'mineflayer';
import { createHTTPTransport, scenarioResponse, resolveBridgeLimits } from '@ifsoul/adapter-sdk/bridge';
import { attachConnector } from './connector.mjs';
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
if (args.length > 1) throw Error('Supply one configuration file');
const c = JSON.parse(await readFile(args[0] ?? 'config.local.json', 'utf8'));
const id = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
if (c.host !== '127.0.0.1' || c.version !== '1.20.2' || c.auth !== 'offline' || c.isolatedOfflineServerApproved !== true ||
 !Number.isInteger(c.port) || c.port < 1024 || c.port > 65535 || !/^[A-Za-z0-9_]{3,16}$/.test(c.botName) ||
 !/^[A-Za-z0-9_]{3,16}$/.test(c.playerName) || c.botName === c.playerName ||
 !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.playerUuid) ||
 !id(c.worldId) || !id(c.memoryId) || !id(c.character?.id) ||
 typeof c.character?.name !== 'string' || !c.character.name || c.character.name.length > 80 ||
 typeof c.character?.temperament !== 'string' || !c.character.temperament || c.character.temperament.length > 160 ||
 !Number.isInteger(c.deadlineMs) || c.deadlineMs < 1000 || c.deadlineMs > 150000 ||
 !Number.isInteger(c.cooldownMs) || c.cooldownMs < 1000 || !Number.isInteger(c.maxCalls) || c.maxCalls < 1 || c.maxCalls > 10) throw Error('Invalid bounded local configuration');
if (c.bridgeLimits !== undefined) resolveBridgeLimits(c.bridgeLimits);
if (c.deadlineMs > 60000 && c.bridgeLimits?.timeoutMs !== c.deadlineMs) throw Error('Extended deadline requires coherent explicit SDK policy');
let transport = async (request) => scenarioResponse(request);
if (c.mode === 'app') {
 const appURL = new URL(c.app);
 if (appURL.protocol !== 'http:' || appURL.hostname !== '127.0.0.1' || appURL.username || appURL.password || appURL.pathname !== '/' || appURL.search || appURL.hash || Number(appURL.port) < 1024 || c.provider !== 'ollama' || typeof c.model !== 'string' || !/^[A-Za-z0-9@][A-Za-z0-9@._:/-]{0,127}$/.test(c.model)) throw Error('Invalid App configuration');
 const endpoint = new URL('/api/bridge', c.app); endpoint.searchParams.set('provider', c.provider); endpoint.searchParams.set('model', c.model);
 transport = createHTTPTransport(endpoint.href, (input, init) => fetch(input, { ...init, redirect: 'error', headers: { ...Object.fromEntries(new Headers(init?.headers)), origin: c.app } }), { limits: c.bridgeLimits });
} else if (c.mode !== 'scenario') throw Error('Choose scenario or app');
const bot = mineflayer.createBot({ host: c.host, port: c.port, version: c.version, username: c.botName, auth: c.auth, hideErrors: true });
const connector = attachConnector(bot, c, transport, (event) => console.log(JSON.stringify(event)));
let stopping = false;
const stop = () => { if (stopping) return; stopping = true; connector.stop(); bot.quit('Local test stopped'); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
bot.once('end', () => { connector.stop(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); });
