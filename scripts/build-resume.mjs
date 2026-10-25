#!/usr/bin/env node
/* ============================================================
   Résumé build: resume/*.md  ->  resume/*.pdf

   The Markdown files are the single source of truth; each PDF is
   rendered from its .md through headless Chrome, so the two can
   never drift apart. Zero dependencies — the converter below only
   handles the Markdown subset the résumé files use (headings,
   paragraphs, "- " lists, **bold**, *italic*, [links](url)).

   Usage:   node scripts/build-resume.mjs
   Chrome:  auto-detected; override with CHROME_PATH=/path/to/chrome
   ============================================================ */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESUME_DIR = join(ROOT, 'resume');

/* ---- Markdown -> HTML ---- */
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(s) {
  return escapeHtml(s)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

// Everything before the first h2 becomes <header>; each h2 opens a <section>,
// which gives the stylesheet clean hooks for the contact block and page breaks.
function mdToHtml(md) {
  const out = [];
  let para = [];
  let list = null;
  let inSection = false;

  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`); list = null; } };
  const flush = () => { flushPara(); flushList(); };

  out.push('<header>');
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      if (level === 2) {
        out.push(inSection ? '</section>' : '</header>');
        out.push('<section>');
        inSection = true;
      }
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
    } else if (/^- /.test(line)) {
      flushPara();
      (list ||= []).push(line.slice(2));
    } else if (line === '') {
      flush();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flush();
  out.push(inSection ? '</section>' : '</header>');
  return out.join('\n');
}

/* ---- Print stylesheet: plain, single column, ATS-parseable ---- */
const CSS = `
@page{size:A4;margin:13mm 15mm}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;font-family:'Inter','Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:9.6pt;line-height:1.45;color:#111}
:root[lang="fa"] body{font-family:'Vazirmatn','Segoe UI',Tahoma,sans-serif;line-height:1.75}
a{color:inherit;text-decoration:none}
strong{font-weight:600;color:#000}
p{margin:0 0 5pt}
ul{margin:0 0 6pt;padding-inline-start:13pt}
li{margin-bottom:2.5pt}
li::marker{color:#4f46e5}

header{margin-bottom:6pt}
h1{font-size:23pt;font-weight:800;letter-spacing:-.02em;line-height:1.15;margin:0 0 3pt}
header p{margin:0 0 2pt;color:#333}
header p:first-of-type{font-size:11.5pt;color:#111}
header p:first-of-type strong{color:#4f46e5;font-weight:700}
header p:last-of-type{font-size:8.6pt;margin-top:4pt}
header a{color:#4f46e5}

section{margin-top:10pt}
h2{font-size:11.5pt;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#4f46e5;
   border-bottom:1.2pt solid #4f46e5;padding-bottom:2pt;margin:0 0 6pt;break-after:avoid}
h3{font-size:10.6pt;font-weight:700;margin:8pt 0 1pt;break-after:avoid}
h3 + p{font-size:8.6pt;color:#555;margin-bottom:4pt;break-after:avoid}
h3 + p em{font-style:normal}
h3 + p a{color:#4f46e5}
li,h3 + p{break-inside:avoid}

/* Persian: no letter-spacing or uppercase on Arabic script; Latin runs
   (phone, e-mail, URLs) are isolated so bidi doesn't reorder them. */
:root[lang="fa"] h1,:root[lang="fa"] h2{letter-spacing:0;text-transform:none}
:root[lang="fa"] h1{line-height:1.4}
[dir="rtl"] a{direction:ltr;unicode-bidi:isolate}
`;

function page(md, lang) {
  const title = /^#\s+(.*)$/m.exec(md)?.[1] ?? 'Résumé';
  const fonts = lang === 'fa'
    ? 'family=Vazirmatn:wght@400;600;700;800'
    : 'family=Inter:wght@400;600;700;800';
  return `<!DOCTYPE html>
<html lang="${lang}" dir="${lang === 'fa' ? 'rtl' : 'ltr'}">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)} — ${lang === 'fa' ? 'رزومه' : 'Résumé'}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${fonts}&display=block">
<style>${CSS}</style>
</head>
<body>
${mdToHtml(md)}
</body>
</html>`;
}

/* ---- Headless Chrome ---- */
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) throw new Error('Chrome not found — set CHROME_PATH to a Chrome/Chromium/Edge binary.');
  return found;
}

function printToPdf(chrome, htmlPath, pdfPath, profileDir) {
  const res = spawnSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    `--user-data-dir=${profileDir}`,
    '--no-pdf-header-footer',
    // Lets the Google Fonts stylesheet and font files finish loading before printing.
    '--virtual-time-budget=15000',
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href,
  ], { encoding: 'utf8' });
  if (res.status !== 0 || !existsSync(pdfPath)) {
    throw new Error(`Chrome failed for ${basename(htmlPath)}:\n${res.stderr || res.error}`);
  }
}

const chrome = findChrome();
const work = mkdtempSync(join(tmpdir(), 'cv-resume-'));
try {
  for (const file of readdirSync(RESUME_DIR).filter((f) => f.endsWith('.md'))) {
    const lang = /-fa\.md$/.test(file) ? 'fa' : 'en';
    const md = readFileSync(join(RESUME_DIR, file), 'utf8');
    const htmlPath = join(work, file.replace(/\.md$/, '.html'));
    const pdfPath = join(RESUME_DIR, file.replace(/\.md$/, '.pdf'));
    writeFileSync(htmlPath, page(md, lang));
    printToPdf(chrome, htmlPath, pdfPath, join(work, 'profile'));
    console.log(`✓ resume/${basename(pdfPath)}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
