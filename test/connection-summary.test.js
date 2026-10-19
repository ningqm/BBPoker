import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionSummary } from '../scripts/summarize-connection-diagnostics.mjs';

const at = Date.parse('2026-10-19T13:40:00+08:00');
const base = {event:'connection_diagnostic',v:1,source:'server',type:'stream_open',at,userId:'synthetic-user',username:'testplayer',room:'123456',pageId:'aaaaaaaaaaaaaaaa',streamId:'bbbbbbbbbbbbbbbb',browser:'Quark'};
test('incident summary joins authenticated server and reported trigger without confusing timestamps or users',()=>{
  const summary = createConnectionSummary({username:'testplayer',room:'123456',from:at-1000,to:at+1000});
  summary.add(JSON.stringify(base));
  summary.add(JSON.stringify({MESSAGE:JSON.stringify({...base,source:'client_report',type:'watchdog',reason:'watchdog_timeout',clientAtMs:at-9000,lastByteAgeMs:9000,visible:true})}));
  summary.add(JSON.stringify({...base,type:'stream_close',reason:'network_close',durationMs:20000}));
  summary.add(JSON.stringify({...base,username:'other'}));
  const result=summary.result();
  assert.equal(result.matched,3);assert.equal(result.streams.length,1);
  assert.equal(result.receivedFrom,'2026-10-19T13:40:00.000+08:00');
  assert.equal(result.streams[0].events[1].clientReportedAt,'2026-10-19T13:39:51.000+08:00');
  assert.equal(result.reasons['client_report:watchdog_timeout'],1);
  assert.equal(result.reasons['server:network_close'],1);
});
test('summary never emits raw header, URL, private payload or unknown reason',()=>{
  const summary=createConnectionSummary({username:'testplayer'});
  const secret='very-sensitive-value';
  summary.add(JSON.stringify({...base,token:secret,headers:{authorization:secret},cards:[secret],reason:secret,error:secret,browser:secret}));
  summary.add(secret);summary.add(JSON.stringify({...base,event:'arbitrary',message:secret}));
  const output=JSON.stringify(summary.result());assert.equal(output.includes(secret),false);
  assert.equal(summary.result().invalidLines,1);assert.equal(summary.result().unrecognized,1);
});
test('summary caps retained stream details and does not merge two identities with matching client IDs',()=>{
  const summary=createConnectionSummary({maxStreams:2});
  for(let i=0;i<45;i++) summary.add(JSON.stringify(base));
  summary.add(JSON.stringify({...base,userId:'another-user'}));
  summary.add(JSON.stringify({...base,streamId:'cccccccccccccccc'}));
  const result=summary.result();assert.equal(result.streams.length,2);
  assert.equal(result.streams[0].events.length,40);assert.equal(result.streams[0].omittedEvents,5);
  assert.equal(result.limitedStreams,1);
});
