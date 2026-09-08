import { spawnSync } from 'node:child_process';

// Inspect names only. Existing encryption keys must never be read or silently rotated.
const listing=spawnSync('bunx',['wrangler','secret','list'],{encoding:'utf8'});
if(listing.status!==0){console.error('Cannot inspect Cloudflare secret names.');process.exit(1);}
let names: {name:string}[];
try{names=JSON.parse(listing.stdout);}catch{console.error('Could not parse Cloudflare secret metadata.');process.exit(1);}
if(names.some(s=>s.name==='ENCRYPTION_KEY')){console.log('Encryption is already configured.');process.exit(0);}
const generated=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
const result=spawnSync('bunx',['wrangler','secret','put','ENCRYPTION_KEY'],{input:generated,encoding:'utf8'});
if(result.status!==0){console.error('Could not configure encryption.');process.exit(1);}
console.log('Encryption configured in Cloudflare. No key was written locally.');
