#!/usr/bin/env node
// rom-verify.js - verify a ROM folder against a No-Intro DAT (libretro-database) by MD5.
// Zips are opened and every inner file is inflated, CRC-32 checked and md5-hashed.
// Usage: node rom-verify.js --system "GCE - Vectrex" --src <folder> --out <folder> [--stage] [--dat <local.dat>]
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const args = {}; const a = process.argv.slice(2);
for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) { const k = a[i].slice(2); args[k] = (a[i+1] && !a[i+1].startsWith('--')) ? a[++i] : true; }
if (!args.system || !args.src || !args.out) { console.error('Usage: node rom-verify.js --system "<DAT name>" --src <folder> --out <folder> [--stage] [--strip-header nes|a78] [--byteswap n64] [--missing] [--dat <file>]'); process.exit(2); }
const SKIP_DIRS = new Set(['downloaded_images','downloaded_videos','logs_arrm','media','images','videos','manuals','snaps']);
const SKIP_EXT = new Set(['.png','.jpg','.jpeg','.gif','.mp4','.xml','.txt','.cfg','.srm','.state','.sav','.log','.nfo','.db']);
const md5 = b => crypto.createHash('md5').update(b).digest('hex');
// With --strip-header (values: nes, a78, or "nes,a78"; bare flag = nes) a file with a recognised copier header
// is also hashed without it, so game data still matches when only the header bytes differ from the DAT's.
//   nes: iNES ("NES\x1a" + 16 bytes)      a78: Atari 7800 ("\x01ATARI7800" + 128 bytes)
const stripModes = new Set(String(args['strip-header'] === true ? 'nes' : (args['strip-header'] || '')).toLowerCase().split(',').map(x => x.trim()).filter(Boolean));
// With --missing the run also writes <name>_missing.csv: every game in the DAT that your folder does not have,
// sorted into Retail / Unlicensed / Proto-Beta-Demo / Aftermarket-Homebrew / Pirate / BIOS (tags are read from the game name and its first file name), plus a one-line summary
// row in missing-summary.csv. Point it at the folder of files you verified (e.g. the "-verified" staging folder).
const category = g => /^\[BIOS\]/i.test(g) ? 'BIOS' : /\((Aftermarket|Homebrew)\)/i.test(g) ? 'Aftermarket-Homebrew' : /\(Pirate\)/i.test(g) ? 'Pirate' : /\(Unl\)/i.test(g) ? 'Unlicensed' : /\((Proto|Beta|Demo|Sample|Kiosk|Debug|Alpha)\b/i.test(g) ? 'Proto-Beta-Demo' : 'Retail';
// With --byteswap n64 a Nintendo 64 file in .v64 (byte-swapped) or .n64 (word-swapped) order is also hashed after
// converting it to .z64 (big-endian, the order the DAT uses). Staging then writes the converted bytes, not a renamed copy.
const swapModes = new Set(String(args['byteswap'] === true ? 'n64' : (args['byteswap'] || '')).toLowerCase().split(',').map(x => x.trim()).filter(Boolean));
const n64Order = b => { if (b.length < 8 || b.length % 4) return null; const h = b.readUInt32BE(0); return h === 0x80371240 ? 'z64' : h === 0x37804012 ? 'v64' : h === 0x40123780 ? 'n64' : null; };
const toZ64 = b => { const o = n64Order(b); if (!o || o === 'z64') return null; const r = Buffer.from(b); if (o === 'v64') r.swap16(); else r.swap32(); return r; };
const isInes = b => b.length > 16 && b[0] === 0x4e && b[1] === 0x45 && b[2] === 0x53 && b[3] === 0x1a;
const isA78 = b => b.length > 128 && b.toString('latin1', 1, 10) === 'ATARI7800';
const cands = (b, allowConv = true) => {
  const out = [{ h: md5(b), stripped: false }];
  if (allowConv && swapModes.has('n64')) { const z = toZ64(b); if (z) out.push({ h: md5(z), stripped: false, conv: true }); }
  if (stripModes.has('nes') && isInes(b)) out.push({ h: md5(b.subarray(16)), stripped: '.nes' });
  if (stripModes.has('a78') && isA78(b)) out.push({ h: md5(b.subarray(128)), stripped: '.a78' });
  return out;
};
const csv = v => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

async function loadDat() {
  fs.mkdirSync(args.out, { recursive: true });
  // --system accepts several DATs separated by commas; prefix "tosec:" or "redump:" picks another libretro folder (default no-intro)
  const names = String(args.system).split(',').map(s => s.trim()).filter(Boolean);
  const files = args.dat ? String(args.dat).split(',').map(s => s.trim()) : [];
  const map = new Map(); const games = new Map(); let n = 0; const vers = [];
  for (let i = 0; i < names.length; i++) {
    let file = files[i];
    if (!file) {
      let folder = 'no-intro', nm = names[i];
      const pm = nm.match(/^(no-intro|tosec|redump):(.*)$/i); if (pm) { folder = pm[1].toLowerCase(); nm = pm[2].trim(); }
      file = path.join(args.out, folder + '_' + nm.replace(/[^A-Za-z0-9+]+/g, '_') + '.dat');
      const url = 'https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/' + folder + '/' + encodeURIComponent(nm) + '.dat';
      const r = await fetch(url);
      if (!r.ok) { console.error('Could not download DAT (' + r.status + '): ' + url); process.exit(1); }
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    }
    const txt = fs.readFileSync(file, 'utf8');
    vers.push((txt.match(/version "([^"]+)"/) || [])[1] || '?');
    let game = '';
    for (const line of txt.split(/\r?\n/)) {
      const g = line.match(/^\s*name "([^"]*)"\s*$/); if (g) { game = g[1]; continue; }
      const m = line.match(/rom \( name "([^"]+)" size (\d+).*?md5 ([0-9A-Fa-f]{32})/);
      if (m) { n++; const k = m[3].toLowerCase(); if (!map.has(k)) map.set(k, { game: game, file: m[1] }); (games.get(game) || games.set(game, []).get(game)).push(k); }
    }
  }
  return { map, games, ver: vers.join(' + '), n, file: files.join(',') };
}

function readZip(buf) { // returns [{name, error, data}]
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('no end-of-central-directory');
  const count = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const out = [];
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), cs = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl); p += 46 + nl + xl + cl;
    if (name.endsWith('/')) continue;
    try {
      if (buf.readUInt32LE(off) !== 0x04034b50) throw new Error('bad local header');
      const ds = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
      const raw = buf.subarray(ds, ds + cs);
      const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : (() => { throw new Error('unsupported method ' + method); })();
      if ((zlib.crc32(data) >>> 0) !== crc) throw new Error('CRC-32 mismatch');
      out.push({ name, data });
    } catch (err) { out.push({ name, error: err.message }); }
  }
  return out;
}

function* walk(dir) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, d.name);
    if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name.toLowerCase())) yield* walk(f); }
    else yield f;
  }
}

(async () => {
  const dat = await loadDat();
  console.log('DAT: ' + args.system + ' version ' + dat.ver + ', ' + dat.n + ' ROM entries');
  const rows = []; const seen = new Map(); let ignored = 0;
  const add = (verdict, rel, fileMd5, innerMd5, entry, note, stripped, conv) => {
    let hit = innerMd5 && dat.map.get(innerMd5);
    if (verdict === 'MATCH') {
      const prev = seen.get(innerMd5);
      if (prev && !conv && prev.row[7].startsWith('Byte order converted')) {
        // an untouched file beats a converted one with the same content: demote the converted row
        prev.row[0] = 'DUPLICATE - skip'; prev.row[7] = 'Same content as ' + rel; prev.row[5] = ''; seen.delete(innerMd5);
      }
      if (seen.has(innerMd5)) rows.push(['DUPLICATE - skip', rel, fileMd5, hit.game, hit.file, '', innerMd5, 'Same content as ' + seen.get(innerMd5).rel]);
      else {
        const st = verdict === 'MATCH' && stripped;
        rows.push(['VERIFIED - copy', rel, fileMd5, hit.game, hit.file, entry ? rel : (st ? hit.file.replace(/\.(unh|bin)$/i, stripped) : hit.file), innerMd5, conv ? 'Byte order converted to .z64 (staged as converted bytes)' : st ? 'Game data matches with the file header removed; the header bytes themselves are not checked' : '']);
        seen.set(innerMd5, { rel, row: rows[rows.length - 1] });
      }
    } else rows.push([verdict, rel, fileMd5, '', '', '', innerMd5 || '', note || '']);
  };
  for (const f of [...walk(args.src)].sort()) {
    const rel = path.relative(args.src, f);
    const ext = path.extname(f).toLowerCase();
    if (SKIP_EXT.has(ext)) { ignored++; continue; }
    const buf = fs.readFileSync(f); const fileMd5 = md5(buf);
    if (ext === '.zip' || ext === '.7z') {
      if (ext === '.7z') { add('NOT CHECKED - 7z unsupported', rel, fileMd5, '', true, 'Extract it or ask for 7z support'); continue; }
      let entries; try { entries = readZip(buf); } catch (err) { add('BAD ZIP - do not copy', rel, fileMd5, '', true, 'Unreadable zip: ' + err.message); continue; }
      if (!entries.length) { add('BAD ZIP - do not copy', rel, fileMd5, '', true, 'Zip has no files'); continue; }
      const bad = entries.find(x => x.error);
      if (bad) { add('BAD ZIP - do not copy', rel, fileMd5, '', true, 'Corrupt entry "' + bad.name + '": ' + bad.error); continue; }
      const all = entries.flatMap(x => cands(x.data, false));
      const hitc = all.find(c => dat.map.has(c.h));
      if (hitc) add('MATCH', rel, fileMd5, hitc.h, true, '', hitc.stripped, false);
      else add('NOT IN DAT - skip for now', rel, fileMd5, all[0].h, true, 'Not a No-Intro match (homebrew, hack, other dump); not necessarily bad');
    } else {
      const hitc = cands(buf).find(c => dat.map.has(c.h));
      if (hitc) add('MATCH', rel, fileMd5, hitc.h, false, '', hitc.stripped, hitc.conv);
      else add('NOT IN DAT - skip for now', rel, fileMd5, fileMd5, false, 'Not a No-Intro match (homebrew, hack, other dump); not necessarily bad');
    }
  }
  // Several files can be the same game (e.g. a clean dump plus one with odd header bytes): keep one, prefer an exact match.
  { const groups = new Map();
    for (const r of rows) if (r[0] === 'VERIFIED - copy') { const k = (r[3] + '|' + r[4]).replace(/\.(unh|bin|nes|a78)$/i, '').toLowerCase(); (groups.get(k) || groups.set(k, []).get(k)).push(r); }
    for (const g of groups.values()) if (g.length > 1) {
      const win = g.find(r => !r[7]) || g[0];
      for (const r of g) if (r !== win) { r[0] = 'DUPLICATE - skip'; r[7] = 'Same game as ' + win[1] + (r[7] ? ' (' + r[7] + ')' : ''); r[5] = ''; }
    } }
  const slug = args.system.replace(/^(no-intro|tosec|redump):/i, '').replace(/[^A-Za-z0-9+]+/g, '_').slice(0, 60);
  const csvPath = path.join(args.out, slug + '_verdicts.csv');
  const head = ['Verdict','Your file','Your md5','No-Intro name','No-Intro filename','Copy to card as','Inner file md5','Note'];
  fs.writeFileSync(csvPath, '﻿' + [head, ...rows].map(r => r.map(csv).join(',')).join('\r\n') + '\r\n');
  const tally = {}; for (const r of rows) tally[r[0]] = (tally[r[0]] || 0) + 1;
  console.log('Checked ' + rows.length + ' files (' + ignored + ' non-ROM files ignored)'); console.log(tally); console.log('Verdicts: ' + csvPath);
  const got = new Set(rows.map(r => r[6])); let miss = 0; for (const k of dat.map.keys()) if (!got.has(k)) miss++;
  console.log('DAT games not in your set: ' + miss);
  for (const r of rows) if (r[0].startsWith('BAD')) console.log('  BAD: ' + r[1] + ' - ' + r[7]);
  if (args.missing) {
    const haveMd5 = new Set(rows.filter(r => r[0].startsWith('VERIFIED') || r[0].startsWith('DUPLICATE')).map(r => r[6]));
    const cats = ['Retail', 'Unlicensed', 'Proto-Beta-Demo', 'Aftermarket-Homebrew', 'Pirate', 'BIOS'];
    const missRows = []; let total = 0, have = 0; const cnt = Object.fromEntries(cats.map(c => [c, 0]));
    for (const [g, md5s] of dat.games) {
      if (!md5s.length || !g || /^\s*$/.test(g)) continue;
      total++;
      if (md5s.some(k => haveMd5.has(k))) { have++; continue; }
      const c = category(g + ' ' + (dat.map.get(md5s[0]) ? dat.map.get(md5s[0]).file : '')); cnt[c]++;
      const reg = (g.match(/\(([^)]*)\)/) || [])[1] || '';
      missRows.push([g, c, reg, dat.map.get(md5s[0]) ? dat.map.get(md5s[0]).file : '']);
    }
    missRows.sort((a, b) => cats.indexOf(a[1]) - cats.indexOf(b[1]) || a[0].localeCompare(b[0]));
    const mp = path.join(args.out, slug + '_missing.csv');
    fs.writeFileSync(mp, '\ufeff' + [['Game', 'Category', 'First tag', 'File name'], ...missRows].map(r => r.map(csv).join(',')).join('\r\n') + '\r\n');
    const sp = path.join(args.out, 'missing-summary.csv'), sh = ['System (DAT)', 'DAT version', 'Games in DAT', 'Have', 'Missing', 'Missing retail', 'Missing proto/beta/demo', 'Missing unlicensed', 'Missing other'];
    const row = [slug, dat.ver, total, have, total - have, cnt.Retail, cnt['Proto-Beta-Demo'], cnt.Unlicensed, cnt['Aftermarket-Homebrew'] + cnt.Pirate + cnt.BIOS];
    let old = fs.existsSync(sp) ? fs.readFileSync(sp, 'utf8').replace(/^\ufeff/, '').split(/\r?\n/).filter(Boolean).slice(1).filter(l => !l.startsWith(csv(slug) + ',')) : [];
    fs.writeFileSync(sp, '\ufeff' + [sh.map(csv).join(','), ...old, row.map(csv).join(',')].join('\r\n') + '\r\n');
    console.log('Have ' + have + ' of ' + total + ' games in the DAT (' + (100 * have / total).toFixed(1) + '%). Missing: retail ' + cnt.Retail + ', proto/beta/demo ' + cnt['Proto-Beta-Demo'] + ', unlicensed ' + cnt.Unlicensed + ', other ' + (cnt['Aftermarket-Homebrew'] + cnt.Pirate + cnt.BIOS));
    console.log('Missing list: ' + mp);
  }
  if (args.stage) {
    const dst = path.join(args.out, slug + '-verified'); fs.mkdirSync(dst, { recursive: true });
    let ok = 0, problems = 0, bytes = 0;
    for (const r of rows.filter(r => r[0].startsWith('VERIFIED'))) {
      const src = path.join(args.src, r[1]), out = path.join(dst, r[5]);
      try {
        if (md5(fs.readFileSync(src)) !== r[2]) throw new Error('source changed');
        fs.mkdirSync(path.dirname(out), { recursive: true });
        if (r[7].startsWith('Byte order converted')) {
          const z = toZ64(fs.readFileSync(src)); if (!z || md5(z) !== r[6]) throw new Error('conversion mismatch');
          fs.writeFileSync(out, z);
          if (md5(fs.readFileSync(out)) !== r[6]) { fs.unlinkSync(out); throw new Error('copy mismatch'); }
        } else {
          fs.copyFileSync(src, out);
          if (md5(fs.readFileSync(out)) !== r[2]) { fs.unlinkSync(out); throw new Error('copy mismatch'); }
        }
        ok++; bytes += fs.statSync(out).size;
      } catch (err) { problems++; console.log('  PROBLEM: ' + r[1] + ' - ' + err.message); }
    }
    console.log('Copied and re-verified: ' + ok + ' (' + (bytes / 1048576).toFixed(1) + ' MB)  ' + (problems ? problems + ' PROBLEMS' : 'No problems.'));
    console.log('Staging folder: ' + dst);
  }
})();
