const fs = require('fs');
const MarkdownIt = require('markdown-it');
const { chromium } = require('playwright');

const SRC = '/home/user/Tade-desk-server/METHODOLOGY.md';
const OUT = '/home/user/Tade-desk-server/METHODOLOGY.pdf';

const md = new MarkdownIt({ html: false, linkify: false, typographer: true });
const body = md.render(fs.readFileSync(SRC, 'utf8'));

// Print stylesheet. Light background: this is meant to be read on a phone and
// printed, not viewed in the dark UI.
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font: 10.5pt/1.55 "DejaVu Sans", "Helvetica Neue", Arial, sans-serif;
         color: #1b1f2a; margin: 0; }
  h1 { font-size: 24pt; margin: 0 0 2mm; letter-spacing: -.02em; }
  h2 { font-size: 15pt; margin: 9mm 0 3mm; padding-bottom: 2mm;
       border-bottom: 1.5px solid #2f6fd0; color: #17335e;
       break-after: avoid; page-break-after: avoid; }
  h3 { font-size: 11.5pt; margin: 6mm 0 2mm; color: #2f3a4e;
       break-after: avoid; page-break-after: avoid; }
  p { margin: 0 0 3mm; }
  ul, ol { margin: 0 0 3mm; padding-left: 6mm; }
  li { margin-bottom: 1.5mm; }
  strong { color: #10141d; }
  hr { border: none; border-top: 1px solid #d8dde6; margin: 8mm 0; }
  a { color: #2f6fd0; text-decoration: none; }

  code { font: 9pt "DejaVu Sans Mono", Menlo, monospace; background: #eef1f6;
         padding: 1px 4px; border-radius: 3px; color: #263048; }
  pre { background: #f6f8fb; border: 1px solid #dde3ec; border-left: 3px solid #2f6fd0;
        border-radius: 4px; padding: 3.5mm 4mm; margin: 0 0 4mm;
        break-inside: avoid; page-break-inside: avoid; }
  pre code { font-size: 8.6pt; background: none; padding: 0; line-height: 1.5;
             white-space: pre-wrap; word-break: break-word; }

  table { border-collapse: collapse; width: 100%; margin: 0 0 4mm; font-size: 9.4pt;
          break-inside: avoid; page-break-inside: avoid; }
  th { text-align: left; background: #eef2f8; border: 1px solid #d3dae5;
       padding: 2mm 2.5mm; font-weight: 700; color: #17335e; }
  td { border: 1px solid #dde3ec; padding: 2mm 2.5mm; vertical-align: top; }
  tr:nth-child(even) td { background: #fafbfd; }

  blockquote { margin: 0 0 4mm; padding: 0 0 0 4mm; border-left: 3px solid #d3dae5;
               color: #4a5568; }
</style></head><body>${body}</body></html>`;

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await b.newPage();
  await p.setContent(html, { waitUntil: 'load' });
  await p.pdf({
    path: OUT,
    format: 'A4',
    printBackground: true,
    margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: `<div style="width:100%;font:8pt 'DejaVu Sans',Arial;color:#8b95a6;
      padding:0 16mm;display:flex;justify-content:space-between">
      <span>Trade Desk — Methodology</span>
      <span class="pageNumber"></span></div>`,
  });
  await b.close();
  console.log('written', OUT, fs.statSync(OUT).size, 'bytes');
})();
