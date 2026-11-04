import assert from 'node:assert/strict';
import { WithingsClient } from '../dist/services/withings-client.js';
const future = Math.floor(Date.now()/1000)+7200;
const token=(userid, access_token='synthetic-a')=>({userid,access_token,refresh_token:'synthetic-refresh',expires_at:future});
function setup(current) {
 const client=new WithingsClient({tokenPath:'/unused-synthetic',clientId:'synthetic',clientSecret:'synthetic',cachePath:'/unused',scopes:[],redirectUri:'http://localhost'});
 let written;
 client.tokenStore={read:async()=>current,withLock:async(fn)=>fn(),write:async(x)=>{written=x;}};
 client.requestTokens=async()=>token('1','synthetic-new');
 return {client,written:()=>written};
}
for (const current of [token('2','synthetic-b'),token(undefined,'synthetic-b')]) {
 const {client}=setup(current);
 client.requestTokens=async()=>{throw Error('must not call provider')};
 await assert.rejects(client.refreshToken(true,token('1')), /identity/);
}
{
 const {client}=setup(token('1','synthetic-new'));
 client.requestTokens=async()=>{throw Error('must reuse same account rotation')};
 assert.equal((await client.refreshToken(true,token('1'))).access_token,'synthetic-new');
}
for (const identity of ['2',undefined]) {
 const {client,written}=setup(token('1'));
 client.requestTokens=async()=>token(identity,'synthetic-new');
 await assert.rejects(client.refreshToken(true,token('1')), /identity/);
 assert.equal(written(),undefined);
}
{
 const {client,written}=setup(token('1'));
 assert.equal((await client.refreshToken(true,token('1'))).userid,'1');
 assert.equal(written().userid,'1');
}
for (const rejected of [() => new Response('', {status:401}), () => Response.json({status:401,body:{}})]) {
 const {client}=setup(token('2','synthetic-b'));
 client.getValidToken=async()=>token('1');
 let calls=0;
 client.fetchWithRetry=async()=>{calls++;return rejected()};
 await assert.rejects(client.get('/measure'),/identity/);
 assert.equal(calls,1,'must not replay the request as another user');
}
{
 const {client}=setup(token('1'));
 client.requestTokens=async()=>{throw Error('must not call provider for legacy identity')};
 await assert.rejects(client.refreshToken(true,token(undefined)),/identity/);
}
{
 const {client}=setup(token('2','synthetic-b'));
 let reads=0;
 client.tokenStore.read=async()=>++reads===1 ? {...token('1'),expires_at:1}:token('2','synthetic-b');
 client.requestTokens=async()=>{throw Error('must not refresh changed account')};
 await assert.rejects(client.get('/measure'),/identity/);
 assert.equal(reads,2,'must recheck identity under lock during proactive refresh');
}
{
 const {client}=setup(token('1'));
 let calls=0;
 client.fetchWithRetry=async()=>{calls++;return new Response(JSON.stringify({status:401,body:{}}),{status:200})};
 await assert.rejects(client.get('/measure'),/Withings API status 401/);
 assert.equal(calls,2,'JSON 401 retries once with the same account, then fails');
}
{
 const {client}=setup(token('1'));
 const seen=[];
 client.fetchWithRetry=async(_url,init)=>{
  seen.push(init.headers.Authorization ?? init.headers.authorization);
  return seen.length===1 ? new Response('{}',{status:401}) : new Response(JSON.stringify({status:0,body:{ok:true}}));
 };
 await client.get('/measure');
 assert.deepEqual(seen,['Bearer synthetic-a','Bearer synthetic-new']);
}
for (const [identity,expected] of [[42,'42'],['42','42'],[undefined,undefined],[1.5,undefined],['0',undefined]]) {
 const {client,written}=setup(token('1'));
 delete client.requestTokens;
 client.getNonce=async()=>'synthetic-nonce';
 client.fetchWithRetry=async()=>new Response(JSON.stringify({status:0,body:{userid:identity,access_token:'synthetic-code',refresh_token:'synthetic-refresh',expires_in:7200}}));
 await client.exchangeCode('synthetic-code');
 assert.equal(written().userid,expected);
}
{
 const {client}=setup(token('1'));
 let current=token('1'), calls=0;
 client.tokenStore.read=async()=>current;
 client.fetchWithRetry=async()=>{
  calls++;
  current=token('2','synthetic-b');
  return Response.json({status:0,body:{measuregrps:[{synthetic:'A'}],more:true}});
 };
 await assert.rejects(client.list('/measure',{all_pages:true,max_pages:2,limit:1}),/identity changed during pagination/);
 assert.equal(calls,1,'must not request a second page as B or return partial mixed results');
}
{
 const {client}=setup(token('1'));
 let calls=0;
 client.fetchWithRetry=async()=>{
  calls++;
  return Response.json({status:0,body:{measuregrps:[{synthetic:'A'}],more:calls===1}});
 };
 assert.equal((await client.list('/measure',{all_pages:true,max_pages:2,limit:1})).records.length,2);
 assert.equal(calls,2);
}
{
 const {client}=setup(token(undefined));
 client.fetchWithRetry=async()=>{throw Error('must not fetch without pagination identity')};
 await assert.rejects(client.list('/measure',{all_pages:true,max_pages:2,limit:1}),/identity is unavailable for pagination/);
}
{
 const {client}=setup(token(undefined));
 client.fetchWithRetry=async()=>Response.json({status:0,body:{measuregrps:[{synthetic:'legacy'}],more:false}});
 assert.equal((await client.list('/measure',{limit:1})).records.length,1);
}
{
 const {client}=setup(token('1'));
 let reads=0;
 client.tokenStore.read=async()=>token(++reads===1?'1':'2');
 client.fetchWithRetry=async()=>{throw Error('must not fetch changed first-page identity')};
 await assert.rejects(client.list('/measure',{all_pages:true,max_pages:2,limit:1}),/identity changed during pagination/);
}
{
 const {client}=setup(token('1'));
 let current=token('1'),calls=0;
 client.tokenStore.read=async()=>current;
 client.fetchWithRetry=async()=>{
  calls++; current=token(undefined);
  return Response.json({status:0,body:{measuregrps:[{synthetic:'A'}],more:true}});
 };
 await assert.rejects(client.list('/measure',{all_pages:true,max_pages:2,limit:1}),/identity changed during pagination/);
 assert.equal(calls,1);
}
console.log('PASS: token identity guards and HTTP 401 no-cross-account replay');
