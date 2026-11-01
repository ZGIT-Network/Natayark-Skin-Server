import {spawnSync} from 'node:child_process';
const git=(args,input)=>{
 const result=spawnSync('git',args,{encoding:'utf8',input});
 if(result.error)throw result.error;
 if(![0,1].includes(result.status))throw new Error(result.stderr||'Git check failed');
 return result.stdout;
};
const generated=[
 '.env','.env.production','.codex/sessions/review.jsonl','.codex/auth.json',
 '.claude/settings.local.json','.cursor/workspace-cache/state.json','.aider.chat.history.md',
 '.opencode/session.json','.serena/cache/index.json','.windsurf/cache/session.json',
 '.continue/sessions/local.json','.trae/session.json','.qoder/cache/index.json',
 '.playwright-cli/page.yml','.playwright-mcp/screenshot.png','.test-artifacts/report.json',
 'output/playwright/account.png','artifacts/backup.sql','storage/textures/fixture.png',
 'test-results/trace.zip','playwright-report/index.html','coverage/coverage-final.json',
 '.cache/browser-state.json','tmp/mock-server.json','temp/review.js','app.tsbuildinfo',
 '.agent/session.json','.agents/state.json','.gemini/history/session.json','CLAUDE.local.md',
 'task_plan.md','implementation_plan.md','findings.md','progress.md','walkthrough.md',
 'scripts/__pycache__/review.cpython-312.pyc','.pytest_cache/v/cache/nodeids',
];
const source=[
 '.env.example','README.md','LICENSE','AGENTS.md','.github/workflows/ci.yml',
 '.cursor/rules/project.mdc','.claude/rules/style.md','.claude/skills/review/SKILL.md',
 '.codex/skills/review/SKILL.md','src/views/home.ejs','tests/fixtures/legacy-default-preview.png',
 'migrations/001_auth_extensions.sql',
 'CLAUDE.md','.github/copilot-instructions.md','.agents/skills/review/SKILL.md',
 '.agent/rules/style.md','.gemini/commands/review.toml','.opencode/agents/review.md',
];
const ignored=new Set(git(['check-ignore','--no-index','--stdin'],[...generated,...source].join('\n')+'\n').trim().split(/\r?\n/).filter(Boolean));
const missing=generated.filter(file=>!ignored.has(file)),hiddenSource=source.filter(file=>ignored.has(file));
const tracked=git(['ls-files','--cached','--ignored','--exclude-standard','-z']).split('\0').filter(Boolean);
if(missing.length||hiddenSource.length||tracked.length){
 if(missing.length)console.error('Generated paths not ignored:',missing.join(', '));
 if(hiddenSource.length)console.error('Project files incorrectly ignored:',hiddenSource.join(', '));
 if(tracked.length)console.error('Ignored files still tracked:',tracked.join(', '));
 process.exitCode=1;
}else console.log(`Repository exclusions verified: ${generated.length} generated paths, ${source.length} project paths, no ignored files tracked.`);
