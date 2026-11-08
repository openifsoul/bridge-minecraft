export function trackClient(bot, role, ledger, failures) {
 const state = { ended: false, expectedKick: false, kicked: false };
 bot.on('kicked', reason => { state.kicked = state.expectedKick && String(reason).includes('Synthetic lifecycle check'); ledger.push({role,event:'kicked',expected:state.kicked}); });
 bot.on('end', () => {state.ended=true;ledger.push({role,event:'end'});});
 bot.on('error', error => {
  const expected=role==='bot' && state.expectedKick && state.kicked && !state.ended && error.code==='EPIPE';
  ledger.push({role,event:'error',code:error.code??'unknown',expected});
  if(!expected)failures.push({role,code:error.code??'unknown'});
 });
 return state;
}
export function waitEnd(bot, state, timeout=10000) {
 if(state.ended)return Promise.resolve();
 return new Promise((resolve,reject)=>{const end=()=>{clearTimeout(timer);bot.removeListener('end',end);resolve();};const timer=setTimeout(()=>{bot.removeListener('end',end);reject(Error('Missing actual end'));},timeout);bot.on('end',end);});
}
export const alternateDimension = current => String(current).includes('nether') ? 'minecraft:overworld' : 'minecraft:the_nether';
