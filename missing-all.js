// missing-all.js - runs rom-verify.js --missing over each system's verified folder and prints one line per system.
// Usage: node missing-all.js        (keep it in the same folder as rom-verify.js)
// Reads only. Writes the lists into Downloads\rom-verify-out-missing (one <system>_missing.csv each + missing-summary.csv).
const { spawnSync } = require('child_process'); const fs = require('fs'); const path = require('path'); const os = require('os');
const dl = path.join(os.homedir(), 'Downloads'), out = path.join(dl, 'rom-verify-out-missing');
const v = path.join(dl, 'rom-verify-out'), verify = path.join(__dirname, 'rom-verify.js');
const systems = [
  ['Atari - 2600', path.join(dl, 'a2600-verified')],
  ['Mattel - Intellivision', path.join(dl, 'intv-verified')],
  ['Atari - 5200', path.join(dl, 'a5200-verified')],
  ['GCE - Vectrex', path.join(v, 'GCE_Vectrex-verified')],
  ['Sega - SG-1000', path.join(v, 'Sega_SG_1000-verified')],
  ['Nintendo - Nintendo Entertainment System', path.join(v, 'Nintendo_Nintendo_Entertainment_System-verified'), ['--strip-header', 'nes']],
  ['Sega - Master System - Mark III', path.join(v, 'Sega_Master_System_Mark_III-verified')],
  ['Atari - 7800', path.join(v, 'Atari_7800-verified'), ['--strip-header', 'a78']],
  ['Sega - Mega Drive - Genesis', path.join(v, 'Sega_Mega_Drive_Genesis-verified')],
  ['Nintendo - Super Nintendo Entertainment System', path.join(dl, 'rom-verify-out-snes2', 'Nintendo_Super_Nintendo_Entertainment_System-verified')],
  ['Atari - Jaguar', path.join(v, 'Atari_Jaguar-verified')],
  ['Sega - 32X', path.join(dl, 'rom-verify-out-32x2', 'Sega_32X-verified')],
  ['Nintendo - Virtual Boy', path.join(dl, 'rom-verify-out-vb2', 'Nintendo_Virtual_Boy-verified')],
  ['Nintendo - Nintendo 64', path.join(v, 'Nintendo_Nintendo_64-verified')],
];
fs.mkdirSync(out, { recursive: true });
for (const [name, dir, extra = []] of systems) {
  if (!fs.existsSync(dir)) { console.log(name + ': SKIPPED, folder not found: ' + dir); continue; }
  const r = spawnSync(process.execPath, [verify, '--system', name, '--src', dir, '--out', out, '--missing', ...extra], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const lines = (r.stdout || '').split(/\r?\n/);
  const have = lines.find(l => l.startsWith('Have ')); const bad = lines.find(l => /"BAD|NOT IN DAT|NOT CHECKED/.test(l));
  console.log(name + ': ' + (have || ('FAILED ' + (r.stderr || '').trim().slice(0, 200))) + (bad ? '  [note: ' + bad.trim() + ']' : ''));
}
console.log('Lists and missing-summary.csv are in: ' + out);
