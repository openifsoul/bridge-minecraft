// Explicit opt-in; uses an already prepared disposable server. Never downloads/accepts EULA.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import mineflayer from 'mineflayer';
import { scenarioResponse } from '@ifsoul/adapter-sdk/bridge';
import { trackClient, waitEnd, alternateDimension } from './lifecycle-ledger.mjs';
import { attachConnector } from '../src/connector.mjs';
const directory = process.env.IFSOUL_TEST_SERVER_DIR;
if (!directory || process.env.IFSOUL_DISPOSABLE_TEST_APPROVED !== 'yes') throw Error('Explicit disposable-server approval required');
const properties = await readFile(resolve(directory, 'server.properties'), 'utf8');
for (const line of ['server-ip=127.0.0.1', 'server-port=25565', 'online-mode=false', 'level-name=ifsoul-disposable']) {
 if (!properties.split(/\r?\n/).includes(line)) throw Error('Unexpected server scope');
}
if (!/^eula=true$/m.test(await readFile(resolve(directory, 'eula.txt'), 'utf8'))) throw Error('Server EULA must already be accepted');
// Refuse to attach to another task's server.
const probe=createServer(); await new Promise((ok,no)=>{probe.once('error',no);probe.listen(25565,'127.0.0.1',ok);}); await new Promise(r=>probe.close(r));
const server=spawn(process.env.IFSOUL_TEST_JAVA ?? 'java',['-Xms256M','-Xmx1024M','-jar','server.jar','nogui'],{cwd:directory,stdio:['pipe','pipe','pipe']});
const clients=[], receipts=[], ledger=[], failures=[], states=new Map(); let connector, pending, mode='normal', calls=0;
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
async function until(fn, label, timeout=10000) { const end=Date.now()+timeout; while(!fn()){if(Date.now()>end)throw Error(`Timed out: ${label}`);await wait(25);} }
function event(emitter,name,timeout=10000){ return once(emitter,name,{signal:AbortSignal.timeout(timeout)}); }
const command=text=>server.stdin.write(`${text}\n`);
let output=''; server.stdout.on('data',data=>{output=(output+data).slice(-16000);}); server.stderr.on('data',()=>{});
async function connect(name){const bot=mineflayer.createBot({host:'127.0.0.1',port:25565,version:'1.20.2',username:name,auth:'offline',hideErrors:true});clients.push(bot);states.set(bot,trackClient(bot,name==='Tester'?'player':'bot',ledger,failures));await event(bot,'spawn');return bot;}
const config={playerName:'Tester',worldId:'disposable-1202',memoryId:'synthetic-native',character:{id:'tavi',name:'Tavi',temperament:'Original concise cartographer'},deadlineMs:1000,cooldownMs:0,maxCalls:10};
function attach(bot){connector=attachConnector(bot,config,async request=>{calls++;if(mode==='hold')return new Promise(r=>{pending=()=>r(scenarioResponse(request));});return scenarioResponse(request);},receipt=>receipts.push(receipt));}
let player, bot, observed=0, result;
async function startBot(){bot=mineflayer.createBot({host:'127.0.0.1',port:25565,version:'1.20.2',username:'TaviBot',auth:'offline',hideErrors:true});clients.push(bot);states.set(bot,trackClient(bot,'bot',ledger,failures));attach(bot);await event(bot,'spawn');await until(()=>bot.players.Tester,'player binding');}
async function held(){mode='hold';pending=undefined;player.whisper('TaviBot','Synthetic held request');await until(()=>pending,'transport started');}
try {
 await until(()=>output.includes('Done ('),'server startup',30000);
 player=await connect('Tester');config.playerUuid=player.player.uuid;
 player.on('whisper',name=>{if(name==='TaviBot')observed++;});
 await startBot(); player.whisper('TaviBot','Synthetic greeting');await until(()=>observed===1,'initial private response');
 // Death aborts a real in-flight server-originated utterance; respawn starts a new epoch.
 await held();const death=event(bot,'death');command('kill TaviBot');await death;pending();await wait(150);assert.equal(observed,1);
 await until(()=>connector.status().ready,'respawn');await wait(1700);
 // Real dimension transfer likewise fences the prior request, even after a new spawn.
 await held();const oldEpoch=connector.status().epoch;const target=alternateDimension(bot.game.dimension);command(`execute in ${target} run tp TaviBot 0 100 0`);await until(()=>String(bot.game.dimension).replace('minecraft:','')===target.replace('minecraft:','') && connector.status().epoch>oldEpoch,'actual dimension boundary');pending();await wait(150);assert.equal(observed,1);
 await until(()=>connector.status().ready,'dimension spawn');await wait(1700);
 // Kick ends the connection; no automatic reconnect or proposal replay.
 await held();states.get(bot).expectedKick=true;const ended=waitEnd(bot,states.get(bot));command('kick TaviBot Synthetic lifecycle check');await ended;pending();await wait(150);assert.equal(observed,1);connector.stop();
 mode='normal';await startBot();player.whisper('TaviBot','Synthetic restart greeting');await until(()=>observed===2,'manual reconnect response');
 // A transport ignoring cancellation is not allowed to leak fallback/late output or drain a queue.
 await held();player.whisper('TaviBot','Synthetic queued request');await until(()=>!connector.status().ready,'deadline invalidation',3000);pending();await wait(150);assert.equal(observed,2);assert.equal(connector.status().queued,0);assert.equal(calls,6);assert.equal(failures.length,0);
 result={status:'passed',minecraft:'1.20.2',mineflayer:'4.39.0',node:process.version,observedReplies:observed,calls,ledger,checks:['private exchange','death stale suppression','dimension stale suppression','kick stale suppression','manual reconnect','timeout queue suppression'],receipts};
} finally {
 connector?.stop();
 for(const client of clients){if(states.get(client)?.ended)continue;if(client.quit)client.quit('Owned safety test complete');else client.end?.();}
 await Promise.all(clients.map(client=>waitEnd(client,states.get(client))));
 await wait(250);
 const exited=once(server,'exit');let stopTimer;try{if(server.exitCode===null)command('stop');await Promise.race([exited,new Promise(r=>{stopTimer=setTimeout(()=>{if(server.exitCode===null)server.kill('SIGTERM');r();},10000);})]);}finally{clearTimeout(stopTimer);}
 if(server.exitCode===null)await Promise.race([once(server,'exit'),wait(3000)]);
 if(server.exitCode===null)throw Error('Owned server cleanup did not complete');
}

assert.equal(failures.length,0);console.log(JSON.stringify({...result,ledger,cleanup:'owned clients ended; server exited'}));
