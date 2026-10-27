const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Runs the actual worker code against Chrome's async message/storage contract.
// The backing data survives worker restarts and separate browser page lifetimes.
module.exports = function storageWorker(data = {}) {
  let listener, fail = false, gets = 0, sets = 0;
  const source = fs.readFileSync(path.join(__dirname,'../../extension/return-storage.js'),'utf8');
  const boot = () => vm.runInNewContext(source, {URL,TextEncoder,chrome:{
    runtime:{id:'voyager-test',onMessage:{addListener(fn){listener=fn;}}},
    storage:{local:{
      async get(key){gets++;if(fail)throw Error('storage unavailable');return {[key]:structuredClone(data[key])};},
      async set(value){sets++;if(fail)throw Error('quota');Object.assign(data,structuredClone(value));}
    }}
  }});
  boot();
  return {data,restart:boot,setFail(value){fail=value;},counts(){return {gets,sets};},
    request(message,url='https://chatgpt.com/c/test'){
      return new Promise(resolve=>{
        const keep=listener(structuredClone(message),{id:'voyager-test',url},value=>resolve(structuredClone(value)));
        if(keep!==true)resolve(null);
      });
    }
  };
};
