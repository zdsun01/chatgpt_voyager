const assert = require('node:assert/strict');
const storageWorker = require('./helpers/storage-worker.cjs');
const KEY='voyager-return-v1';
const record=(i,large=false)=>({userKey:`data-turn-key:user-${i}`,prompt:'8:123:456',at:i,
  target:{attr:'data-chatgpt-search-message-ids',value:`answer-${i}`,part:0},
  anchor:{id:{attr:'data-chatgpt-search-message-ids',value:large ? `source-${i}-`+'源'.repeat(480) : 'source-A',part:0},
    start:10,quote:'问'.repeat(large?160:20),prefix:'前'.repeat(40),suffix:'后'.repeat(40),top:200,viewportOffset:40}});
(async()=>{
  const worker=storageWorker();
  const save=(chat,values)=>worker.request({type:'voyager:return:save',chat,records:values});
  const load=chat=>worker.request({type:'voyager:return:load',chat});
  await Promise.all([save('/c/one',[record(1)]),save('/c/one',[record(2)]),save('/c/two',[record(3)])]);
  assert.equal((await load('/c/one')).records.length,2);
  assert.equal((await load('/c/two')).records.length,1);
  // An old tab cannot replace an established response's source.
  const altered=record(1);altered.anchor.id.value='wrong-source';
  await save('/c/one',[altered]);assert.equal((await load('/c/one')).records[0].anchor.id.value,'source-A');
  worker.restart();assert.equal((await load('/c/one')).records.length,2);
  const before=JSON.stringify(worker.data);
  await save('/c/one',[{...record(4),anchor:{...record(4).anchor,quote:'x'.repeat(161)}}]);
  await save('/c/one',[{...record(4),userKey:'local:4'}]);
  assert.equal(JSON.stringify(worker.data),before);
  assert.equal(await worker.request({type:'voyager:return:load',chat:'/c/one'},'https://example.com'),null);
  worker.setFail(true);assert.equal((await load('/c/one')).ok,false);worker.setFail(false);
  assert.equal((await load('/c/one')).ok,true);
  for(let i=4;i<29;i++)await save('/c/one',[record(i)]);
  assert.equal((await load('/c/one')).records.length,20);
  for(let i=0;i<55;i++)await save(`/c/chat-${i}`,[record(i)]);
  assert.equal(Object.keys(worker.data[KEY].chats).length,50);
  assert.equal((await load('/c/chat-0')).records.length,0);
  // Worst-case UTF-8 fragments force byte-cap eviction before the count cap.
  for(let i=0;i<50;i++)await save(`/c/large-${i}`,Array.from({length:20},(_,j)=>record(i*20+j,true)));
  const bytes=Buffer.byteLength(JSON.stringify(worker.data[KEY]))+KEY.length;
  assert.ok(bytes<=512*1024,bytes);
  assert.ok(Object.keys(worker.data[KEY].chats).length<50);
  const sizes=[record(1),...Array.from({length:19},(_,i)=>record(i+2))];
  console.log(`PASS: concurrent tab merge; restart; immutable origins; validation; failure recovery; 20 records/chat; 50 chats; byte cap ${bytes} bytes. Typical fixture: ${Buffer.byteLength(JSON.stringify(sizes))} bytes for 20 records (stored data, not process memory).`);
})().catch(e=>{console.error(e);process.exitCode=1;});
