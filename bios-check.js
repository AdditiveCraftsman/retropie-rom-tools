#!/usr/bin/env node
// bios-check.js - check a BIOS folder against libretro's System.dat (the list of BIOS/firmware files the cores use).
// Every file is matched by md5, so a right file with the wrong name still counts, and it is staged under the name the core expects.
// Zip BIOS sets are also opened and every entry's CRC-32 is checked, so damaged zips are caught.
// Usage: node bios-check.js --src <BIOS folder> --out <folder> [--stage] [--dat <System.dat>]
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const args = {}; const a = process.argv.slice(2);
for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) { const k = a[i].slice(2); args[k] = (a[i+1] && !a[i+1].startsWith('--')) ? a[++i] : true; }
if (!args.src || !args.out) { console.error('Usage: node bios-check.js --src <BIOS folder> --out <folder> [--stage] [--dat <System.dat>]'); process.exit(2); }
const md5 = b => crypto.createHash('md5').update(b).digest('hex');
const csv = v => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

function zipProblem(buf) { // returns '' when every entry inflates and matches its CRC-32, else a short reason
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) return 'no end-of-central-directory';
  try {
    const count = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16);
    for (let k = 0; k < count; k++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) return 'bad central directory';
      const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), cs = buf.readUInt32LE(p + 20);
      const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
      const name = buf.toString('utf8', p + 46, p + 46 + nl); p += 46 + nl + xl + cl;
      if (name.endsWith('/')) continue;
      if (buf.readUInt32LE(off) !== 0x04034b50) return 'bad local header in "' + name + '"';
      const ds = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), raw = buf.subarray(ds, ds + cs);
      const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
      if (!data) return 'unsupported method ' + method;
      if ((zlib.crc32(data) >>> 0) !== crc) return 'CRC-32 mismatch in "' + name + '"';
    }
    return '';
  } catch (err) { return err.message; }
}

function* walk(dir) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, d.name);
    if (d.isDirectory()) yield* walk(f); else yield f;
  }
}

(async () => {
  fs.mkdirSync(args.out, { recursive: true });
  let datPath = args.dat;
  if (!datPath) {
    datPath = path.join(args.out, 'System.dat');
    const r = await fetch('https://raw.githubusercontent.com/libretro/libretro-database/master/dat/System.dat');
    if (!r.ok) { console.error('Could not download System.dat (' + r.status + ')'); process.exit(1); }
    fs.writeFileSync(datPath, Buffer.from(await r.arrayBuffer()));
  }
  const txt = fs.readFileSync(datPath, 'utf8');
  const ver = (txt.match(/version "?([^"\r\n]+)"?/) || [])[1] || '?';
  const want = []; let system = '';
  for (const line of txt.split(/\r?\n/)) {
    const c = line.match(/^\s*comment "([^"]*)"\s*$/); if (c) { system = c[1]; continue; }
    const m = line.match(/rom \( name (?:"([^"]+)"|(\S+)) size (\d+) .*?md5 ([0-9A-Fa-f]{32})/);
    if (m) want.push({ system, file: m[1] || m[2], size: +m[3], md5: m[4].toLowerCase() });
  }
  console.log('System.dat version ' + ver + ': ' + want.length + ' BIOS/firmware entries');

  const sizes = new Set(want.map(w => w.size)); const wantedNames = new Set(want.map(w => path.basename(w.file).toLowerCase()));
  const byMd5 = new Map(); const byName = new Map(); let scanned = 0, hashed = 0; const zips = new Map();
  for (const f of walk(args.src)) {
    scanned++;
    const rel = path.relative(args.src, f), st = fs.statSync(f);
    const isZip = /\.zip$/i.test(f), nameWanted = wantedNames.has(path.basename(f).toLowerCase());
    const headerSize = sizes.has(st.size - 512);   // some dumps carry a 512-byte copier header
    if (!sizes.has(st.size) && !headerSize && !nameWanted) continue;
    const buf = fs.readFileSync(f); hashed++; const h = md5(buf);
    if (!byMd5.has(h)) byMd5.set(h, []); byMd5.get(h).push({ rel, strip: false });
    if (headerSize) { const h2 = md5(buf.subarray(512)); if (!byMd5.has(h2)) byMd5.set(h2, []); byMd5.get(h2).push({ rel, strip: true }); }
    const bn = path.basename(f).toLowerCase(); if (nameWanted) { if (!byName.has(bn)) byName.set(bn, []); byName.get(bn).push({ rel, h }); }
    if (isZip) zips.set(rel, zipProblem(buf));
  }
  console.log('Looked at ' + scanned + ' files, hashed ' + hashed + ' that could be BIOS files.');

  const rows = []; const tally = {};
  const dst = path.join(args.out, 'bios-verified'); let staged = 0, stageProblems = 0;
  for (const w of want) {
    const hits = byMd5.get(w.md5) || []; let verdict, note = '', src = '', strip = false;
    if (hits.length) {
      const best = hits.find(r => !r.strip && path.basename(r.rel).toLowerCase() === path.basename(w.file).toLowerCase()) || hits.find(r => !r.strip) || hits[0];
      src = best.rel; strip = best.strip;
      verdict = 'OK'; if (path.basename(src).toLowerCase() !== path.basename(w.file).toLowerCase()) note = 'Right file under another name; staged as ' + w.file;
      if (strip) note = (note ? note + '. ' : '') + 'Your copy has a 512-byte header; staged without it';
      if (zips.has(src) && zips.get(src)) { verdict = 'DAMAGED ZIP'; note = zips.get(src); }
    } else {
      const same = byName.get(path.basename(w.file).toLowerCase()) || [];
      if (same.length) {
        const z = same.find(s => zips.has(s.rel));
        if (z && zips.get(z.rel)) { verdict = 'DAMAGED ZIP'; note = zips.get(z.rel) + ' (' + z.rel + ')'; }
        else { verdict = z ? 'DIFFERENT VERSION (zip is intact)' : 'DIFFERENT VERSION OR DAMAGED'; note = 'Present as ' + same.map(s => s.rel + '=' + s.h.slice(0, 8)).join('; ') + ' but md5 differs from the published ' + w.md5.slice(0, 8) + ' (expected size ' + w.size + ')'; }
      } else verdict = 'MISSING';
    }
    tally[verdict] = (tally[verdict] || 0) + 1;
    if (args.stage && verdict === 'OK') {
      try {
        const out = path.join(dst, w.file); fs.mkdirSync(path.dirname(out), { recursive: true });
        if (strip) fs.writeFileSync(out, fs.readFileSync(path.join(args.src, src)).subarray(512)); else fs.copyFileSync(path.join(args.src, src), out);
        if (md5(fs.readFileSync(out)) !== w.md5) { fs.unlinkSync(out); throw new Error('copy mismatch'); }
        staged++;
      } catch (err) { stageProblems++; console.log('  PROBLEM: ' + w.file + ' - ' + err.message); }
    }
    rows.push([w.system, w.file, w.md5, verdict, src, note]);
  }
  const bySys = {}; for (const r of rows) { const s = bySys[r[0]] || (bySys[r[0]] = { ok: 0, total: 0 }); s.total++; if (r[3] === 'OK') s.ok++; }
  const csvPath = path.join(args.out, 'bios_check.csv');
  fs.writeFileSync(csvPath, '﻿' + [['System', 'Expected file', 'Published md5', 'Verdict', 'Your file', 'Note'], ...rows].map(r => r.map(csv).join(',')).join('\r\n') + '\r\n');
  console.log(tally); console.log('Verdicts: ' + csvPath);
  console.log('By system (OK / listed):'); for (const [s, v] of Object.entries(bySys)) console.log('  ' + s + ': ' + v.ok + ' / ' + v.total);
  for (const r of rows) if (r[3].startsWith('DAMAGED')) console.log('  DAMAGED: ' + r[1] + ' - ' + r[5]);
  if (args.stage) console.log('Copied and re-verified: ' + staged + '  ' + (stageProblems ? stageProblems + ' PROBLEMS' : 'No problems.') + '\nStaging folder: ' + dst);
})();
