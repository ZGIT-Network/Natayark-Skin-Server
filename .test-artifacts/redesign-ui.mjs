import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

let css = fs.readFileSync('src/styles/app.css', 'utf8');
css = css.replace('Design tokens — shadcn/ui "new-york" scale with a teal brand accent.', 'Shared surfaces, typography and restrained interaction states.');
const palette = {
  '0.625rem': '0.25rem', '#ffffff': '#ffffff', '#09090b': '#242625', '#18181b': '#292c2a',
  '#f4f4f5': '#f1f2ef', '#71717a': '#737870', '#e4e4e7': '#dedfd9', '#0d9488': '#a44737',
  '#0f766e': '#8e3e31', '#f0fdfa': '#f5efeb', '#fafafa': '#f8f9f6', '#3f3f46': '#555b54',
};
const themeEnd = css.indexOf('@theme inline');
let tokens = css.slice(0, themeEnd);
tokens = tokens.replace(/0\.625rem|#[a-fA-F0-9]{6}/g, value => palette[value] || value);
tokens = tokens.replace('--background: #ffffff;', '--background: #f7f8f5;');
tokens = tokens.replace('--background: #242625;', '--background: #191b1a;');
tokens = tokens.replaceAll('#0f0f11', '#202320').replaceAll('#27272a', '#353a35').replaceAll('#0c0c0e', '#1c1f1c');
tokens = tokens.replaceAll('#2dd4bf', '#d79c8d').replaceAll('#5eead4', '#e8b2a5').replaceAll('#042f2e', '#2c1e18');
tokens = tokens.replace('rgba(45, 212, 191, 0.1)', 'rgba(215, 156, 141, 0.08)');
css = tokens + css.slice(themeEnd);
css = css.replace('--radius-sm: calc(var(--radius) - 4px);', '--radius-sm: 2px;')
  .replace('--radius-md: calc(var(--radius) - 2px);', '--radius-md: 3px;')
  .replace('--radius-xl: calc(var(--radius) + 4px);', '--radius-xl: 5px;');
css = css.replace(/\s*(?:box-shadow|text-shadow|backdrop-filter):[^;]+;/g, '');
css = css.replace('border-color 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease', 'border-color 0.12s ease, opacity 0.12s ease');
css = css.replaceAll('border-color 0.15s ease, box-shadow 0.15s ease', 'border-color 0.12s ease');
css = css.replaceAll(', transform 0.15s ease', '');
css = css.replace(/\.btn:focus-visible \{[^}]*\}/, '.btn:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }');
css = css.replace(/(\.select:focus-visible \{)[^}]*\}/, '$1 outline: 2px solid var(--ring); outline-offset: 1px; border-color: var(--ring); }');
css = css.replace(/\.stat-card:hover \{[^}]*\}/, 'a.stat-card:hover { border-color: var(--muted-foreground); }');
css = css.replace(/\.texture-card:hover \{[^}]*\}/, '.texture-card:hover { border-color: var(--muted-foreground); }');
css = css.replace(/    background:\s*linear-gradient\(var\(--muted\)[\s\S]*?color-mix\(in oklab, var\(--muted\) 45%, var\(--card\)\);/, '    background: var(--muted);');
css = css.replace(/\s*filter: drop-shadow\([^;]+;/g, '');
css = css.replace(/  \.auth-page::before \{[\s\S]*?\n  \}/, '');
css = css.replace(/  \/\* Brand mark [\s\S]*?(?=  \/\* Auth)/, `  .site-wordmark {
    display: inline-block; min-width: 0; font-size: 0.9375rem; font-weight: 600;
    letter-spacing: -0.035em; line-height: 1.3; white-space: nowrap;
  }

`);
css = css.replace(/(\.auth-brand \{)[\s\S]*?\n  \}/, '$1 display: flex; align-items: flex-start; margin-bottom: 1.75rem; }');
css = css.replace(/(\.auth-brand-name \{)[\s\S]*?\n  \}/, '$1 font-size: 1.0625rem; font-weight: 600; letter-spacing: -0.025em; }');
css = css.replace('overflow: hidden;\n    background: var(--background);', 'overflow: auto;\n    background: var(--background);');
css = css.replace('width: 17rem;', 'width: 15rem;');
css = css.replaceAll('height: 4rem;', 'height: 3.5rem;');
css = css.replace('padding: 0 1.25rem;\n    font-size: 0.95rem;', 'padding: 0 1.125rem;\n    font-size: 0.95rem;');
css = css.replace('background: color-mix(in oklab, var(--background) 82%, transparent);', 'background: var(--card);');
css = css.replace('max-width: 90rem;', 'max-width: 84rem;');
css = css.replace(/(\.nav-item\.active \{)[^}]*\}/, '$1 background: var(--secondary); color: var(--foreground); border-left-color: var(--brand); }');
css = css.replace(/(\.nav-item \{)/, '$1\n    border-left: 2px solid transparent;');
css = css.replace(/(\.dark \.nav-item\.active \{)[^}]*\}/, '$1 color: var(--foreground); }');
css = css.replace('border-radius: 9999px;\n    border: 1px solid transparent;', 'border-radius: 3px;\n    border: 1px solid transparent;');
css = css.replace('animation: dropdown-in 0.13s ease-out;', 'box-shadow: 0 4px 12px rgb(0 0 0 / 8%);\n    animation: dropdown-in 0.12s ease-out;');
css = css.replace('background: rgba(9, 9, 11, 0.58);', 'background: rgb(0 0 0 / 35%);\n    animation: surface-in 0.16s ease-out;');
css = css.replace('animation: dialog-in 0.16s ease-out;', 'box-shadow: 0 8px 28px rgb(0 0 0 / 12%);\n    animation: dialog-in 0.16s ease-out;');
css = css.replace('animation: toast-in 0.2s ease-out;', 'box-shadow: 0 3px 12px rgb(0 0 0 / 8%);\n    border-left: 2px solid var(--muted-foreground);\n    animation: toast-in 0.16s ease-out;');
const homeStart = css.indexOf('  .hero {');
const homeEnd = css.indexOf('  /* Misc', homeStart);
assert.ok(homeStart > 0 && homeEnd > homeStart);
css = css.slice(0, homeStart) + `  .home-page { background: var(--card); }
  .home-container { width: min(100% - 3rem, 72rem); margin-inline: auto; }
  .home-header { border-bottom: 1px solid var(--border); }
  .home-header-inner { display: flex; align-items: center; gap: 2.5rem; min-height: 4rem; }
  .home-nav, .home-account { display: flex; align-items: center; gap: 1rem; }
  .home-account { margin-left: auto; gap: 0.25rem; }
  .home-nav-link { font-size: 0.8125rem; color: var(--muted-foreground); }
  .home-nav-link:hover { color: var(--foreground); }
  .home-intro { display: grid; grid-template-columns: 1fr 1fr; align-items: center; gap: 4rem; padding-block: 3.75rem; }
  .home-kicker { font-size: 0.75rem; color: var(--muted-foreground); margin-bottom: 1rem; }
  .home-intro h1 { font-size: clamp(1.8rem, 3vw, 2.75rem); letter-spacing: -0.055em; font-weight: 550; line-height: 1.15; }
  .home-description { max-width: 30rem; margin-top: 1.25rem; font-size: 0.875rem; line-height: 1.8; color: var(--muted-foreground); }
  .home-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.625rem; margin-top: 1.75rem; }
  .home-actions .home-text-link { margin-left: 0.5rem; }
  .home-visual { min-height: 17rem; background-size: cover; background-position: center; border: 1px solid var(--border); border-radius: 3px; }
  .home-visual-fixed { background-attachment: fixed; }
  .home-library { border-top: 1px solid var(--border); padding-block: 2rem 2.5rem; }
  .home-section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: 1.25rem; }
  .home-section-heading h2 { font-size: 1rem; font-weight: 600; }
  .home-section-heading p { margin-top: 0.35rem; font-size: 0.75rem; color: var(--muted-foreground); }
  .home-text-link { font-size: 0.8125rem; text-decoration: underline; text-underline-offset: 0.25rem; text-decoration-color: var(--border); }
  .home-text-link:hover { text-decoration-color: currentColor; }
  .home-text-link > span { margin-left: 0.25rem; }
  .home-textures { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 1rem; }
  .home-textures .texture-preview { min-height: 11rem; }
  .texture-caption { display: flex; flex-direction: column; gap: 0.25rem; padding: 0.75rem; font-size: 0.8125rem; }
  .texture-caption small { color: var(--muted-foreground); font-size: 0.6875rem; }
  .home-empty { padding-block: 3rem; font-size: 0.875rem; color: var(--muted-foreground); }
  .home-guide { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2.5rem; border-top: 1px solid var(--border); padding-block: 2rem 3rem; }
  .home-guide h2 { font-size: 0.875rem; font-weight: 600; }
  .home-guide p { margin: 0.5rem 0 0.875rem; font-size: 0.8125rem; line-height: 1.7; color: var(--muted-foreground); }
  .home-footer { border-top: 1px solid var(--border); padding-block: 1.5rem; font-size: 0.6875rem; line-height: 1.8; color: var(--muted-foreground); }
  .home-footer a { text-decoration: underline; text-underline-offset: 0.2rem; }
  .overview-stats { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid var(--border); background: var(--card); }
  .overview-stats .stat-card { border: 0; border-right: 1px solid var(--border); border-radius: 0; background: transparent; }
  .overview-stats .stat-card:last-child { border-right: 0; }
  .toast-success { border-left-color: var(--success); }
  .toast-error { border-left-color: var(--destructive); }
  dialog.dialog.is-closing { animation: surface-out 0.12s ease-in forwards; }
  dialog.dialog.is-closing::backdrop { animation: surface-out 0.12s ease-in forwards; }
  .tab-panel:not([hidden]) { animation: surface-in 0.12s ease-out; }
  .dropdown-menu.is-closing { animation: surface-out 0.1s ease-in forwards; pointer-events: none; }
  .sidebar-backdrop { animation: surface-in 0.16s ease-out; }
  @media (max-width: 767px) {
    .home-container { width: calc(100% - 2rem); }
    .home-header-inner { gap: 1rem; flex-wrap: wrap; padding-block: 0.75rem; }
    .home-nav { order: 3; width: 100%; gap: 1.25rem; }
    .home-intro { grid-template-columns: 1fr; gap: 1.75rem; padding-block: 2.25rem; }
    .home-visual { min-height: 12rem; }
    .home-textures { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.625rem; }
    .home-textures .texture-preview { min-height: 8rem; padding: 0.625rem; }
    .home-textures .texture-preview img { max-height: 7rem; }
    .home-guide { grid-template-columns: 1fr; gap: 1.5rem; }
    .overview-stats { grid-template-columns: repeat(2, 1fr); }
    .overview-stats .stat-card:nth-child(2) { border-right: 0; }
    .overview-stats .stat-card:nth-child(-n+2) { border-bottom: 1px solid var(--border); }
  }

` + css.slice(homeEnd);
css = css.replace('translateY(-4px) scale(0.98)', 'translateY(-3px)').replace('translateY(8px) scale(0.985)', 'translateY(5px)').replaceAll('translateY(0) scale(1)', 'translateY(0)');
css = css.replace('@media (prefers-reduced-motion: reduce)', '@keyframes surface-in { from { opacity: 0; } to { opacity: 1; } }\n@keyframes surface-out { from { opacity: 1; } to { opacity: 0; } }\n\n@media (prefers-reduced-motion: reduce)');
fs.writeFileSync('src/styles/app.css', css);

function walk(directory) { return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]); }
let removed = 0;
for (const file of walk('src/views').filter(file => file.endsWith('.ejs') && !file.endsWith('home.ejs'))) {
  let template = fs.readFileSync(file, 'utf8').replaceAll("'MCNSKIN'", "'Natayark SkinServer'");
  template = template.replace(/<span class="(?:stat-icon|feature-icon)"><%- icon\([^%]+%><\/span>\s*/g, () => { removed++; return ''; });
  template = template.replace(/(<div class="empty-state[^>]*>\s*)<%- icon\([^%]+%>/g, (_, before) => { removed++; return before; });
  if (file.endsWith('sidebar.ejs')) template = template.replace(/<%- icon\('(?!x')[^%]+%>/g, () => { removed++; return ''; });
  template = template.split('\n').map(line => {
    // Remove redundant icons in labelled, single-line actions; keep icon-only controls.
    if (!line.includes('</button>') && !line.includes('</a>')) return line;
    return line.replace(/<%- icon\([^%]+%>(?=(?:\s*<span[^>]*>)?(?:[^<\s]|<%=)[\s\S]*?<\/(?:a|button)>)/g, () => { removed++; return ''; });
  }).join('\n');
  // Large status badges add decoration without adding information to these messages.
  template = template.replace(/<div class="mx-auto flex size-12[^>]*>\s*<%- icon\([^%]+%>\s*<\/div>/g, '');
  if (file.endsWith(path.join('admin', 'index.ejs'))) template = template.replace('class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"', 'class="overview-stats"');
  fs.writeFileSync(file, template);
}
for (const file of ['src/app.ts', 'src/routes/yggdrasil.ts', 'src/services/mail.ts']) {
  let source = fs.readFileSync(file, 'utf8').replaceAll("'MCNSKIN'", "'Natayark SkinServer'").replaceAll("'Natayark Skin'", "'Natayark SkinServer'");
  fs.writeFileSync(file, source);
}
console.log('Removed ' + removed + ' decorative icon instances.');
