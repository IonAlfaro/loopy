const {spawn,spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
const fixture = path.join(root,'.loors-acceptance');
const repo = path.join(fixture,'repo');
const cli = path.join(root,'src-tauri','target','debug','loors-cli.exe');
const git = (dir,...args) => {
  const result = spawnSync('git',['-C',dir,...args],{encoding:'utf8'});
  if(result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
};
const originals = () => [git(repo,'status','--porcelain'),git(repo,'diff','--binary')];
const before = originals();
const modelDir = 'C:/Users/ional/AppData/Local/loors/models';
const model = path.join(modelDir,fs.readdirSync(modelDir).find(name=>name.includes('Qwen3.6-35B-A3B') && name.endsWith('.gguf')));
const child = spawn(cli,['agent','--worktree','--workspace',repo,'--model',model,'--backend','vulkan','--context','16384','Acceptance CLI Qwen - Run exactly node test.cjs in the workspace (do not prefix it with cd), fix the failing test by editing only sum.cjs, then run exactly node test.cjs again. Summarize the result.'],{stdio:['pipe','pipe','pipe']});
let stderr = '', scan = 0;
const timeout = setTimeout(()=>{ console.error('Acceptance timed out'); child.kill(); },360000);
child.stderr.on('data',chunk=>{
  const msg = chunk.toString();
  stderr += msg;
  process.stderr.write(msg);
  const end = 'Allow? [y/N] ';
  let index;
  while ((index = stderr.indexOf(end,scan)) >= 0) {
    const section = stderr.slice(scan,index);
    scan = index + end.length;
    const match = section.match(/(?:^|\n)(\w+) (\{[^\n]*\})\r?\n$/);
    const args = match ? JSON.parse(match[2]) : {};
    const allowed = match && ((match[1] === 'run_cmd' && args.command === 'node test.cjs') ||
      (match[1] === 'edit_file' && args.path === 'sum.cjs' && args.new_text === 'module.exports = (a,b) => a+b;'));
    child.stdin.write(allowed ? 'y\n' : 'n\n');
  }
});
child.stdout.on('data',chunk=>process.stdout.write(chunk));
child.on('close',code=>{
  clearTimeout(timeout);
  const session = /Session: .* \(([a-f0-9]+)\)/.exec(stderr)?.[1];
  const worktree = /Workspace: ([^\r\n]+)/.exec(stderr)?.[1];
  if (code !== 0 || !session || !worktree) process.exit(code || 1);
  const clean = JSON.stringify(before) === JSON.stringify(originals());
  const patch = git(worktree,'diff','--','sum.cjs');
  const verify = spawnSync(cli,['run',path.join(fixture,'verify.loors.json'),'--workspace',worktree,'--jsonl'],{encoding:'utf8'});
  fs.writeFileSync(path.join(fixture,'cli-agent-verify.jsonl'),verify.stdout);
  console.log(JSON.stringify({session,worktree,originalUnchanged:clean,patch,verificationExit:verify.status}));
  if (!clean || !patch || verify.status !== 0) process.exitCode = 1;
});
