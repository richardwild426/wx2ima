import { passwordHash } from '../src/security';
import { spawn } from 'node:child_process';

/** Read directly from the user's terminal without echoing secrets into logs or history. */
async function hiddenPrompt(label: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Run this command in an interactive terminal.');
  process.stdout.write(label);
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    function done() { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener('data', input); process.stdout.write('\n'); }
    function input(chunk: string) {
      for (const char of chunk) {
        if (char === '\u0003') { done(); reject(new Error('Cancelled.')); return; }
        if (char === '\r' || char === '\n') { done(); resolve(value); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char.charCodeAt(0) >= 32) value += char;
      }
    }
    process.stdin.on('data', input);
  });
}
try {
  const first = await hiddenPrompt('New shared access password (input hidden): ');
  if(first.length < 12 || first.length > 256 || first.trim() !== first) throw new Error('Use 12–256 characters, with no leading or trailing spaces.');
  const second = await hiddenPrompt('Confirm access password (input hidden): ');
  if(first !== second) throw new Error('The passwords did not match.');
  const hash = await passwordHash(first);
  const child = spawn('bunx', ['wrangler','secret','put','ACCESS_PASSWORD_HASH'], {cwd: new URL('..',import.meta.url),stdio:['pipe','inherit','inherit']});
  child.stdin.end(hash);
  const code = await new Promise<number | null>(resolve => child.on('exit', resolve));
  if(code !== 0) throw new Error('Cloudflare could not save the password.');
  console.log('Access password saved. Open your configured website to sign in.');
} catch(error) { console.error(error instanceof Error ? error.message : 'Password setup failed.'); process.exitCode=1; }
