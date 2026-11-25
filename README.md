# retropie-rom-tools

Small Node.js tools for checking a RetroPie ROM and BIOS collection against the public
[libretro-database](https://github.com/libretro/libretro-database) lists, so you know which files are
good, which are damaged, and which games are still missing.

No ROMs or BIOS files are included or downloaded. The tools only read your files and fetch the
public DAT lists (checksums and names). Requires Node.js 18 or newer and nothing else (no npm install).

## rom-verify.js

Checks one system's folder against a DAT by MD5. Zip files are opened, and every inner file is
inflated, CRC-32 checked and hashed.

```
node rom-verify.js --system "<DAT name>" --src <folder> --out <folder> [options]
```

| Option | What it does |
| --- | --- |
| `--system` | DAT name, e.g. `"Nintendo - Super Nintendo Entertainment System"`. Prefix with `no-intro:`, `tosec:` or `redump:` to pick the database. Comma-separate to use several DATs. |
| `--src` | Folder with your files (searched recursively). |
| `--out` | Folder for the report (`<system>_verdicts.csv`). |
| `--stage` | Also copy verified files into `<out>/<system>-verified`, named as the DAT expects. Do not use it on multi-track disc images: renaming the `.bin` files breaks their `.cue`. |
| `--strip-header nes\|a78` | Also hash without the NES (iNES) or Atari 7800 copier header. |
| `--byteswap n64` | Also hash `.v64`/`.n64` files after converting them to `.z64`. |
| `--missing` | Write `<system>_missing.csv` (every DAT game you do not have, by category) and add a row to `missing-summary.csv`. |
| `--dat <file>` | Use a local DAT instead of downloading one. |

Notes:
- `.7z` archives are not read (reported as "NOT CHECKED"); extract them first.
- The libretro Redump DATs list the data track of a disc (Track 01) only, so audio tracks show as
  "NOT IN DAT". Check disc images with `chdman verify` as well.

Example:

```
node rom-verify.js --system "Nintendo - Virtual Boy" --src D:\roms\virtualboy --out D:\verify-out --stage
```

## bios-check.js

Checks a BIOS folder against libretro's `System.dat` (the firmware list the cores use). Files are
matched by MD5, so a correct file with the wrong name still counts. Zip BIOS sets are opened and
every entry's CRC-32 is checked.

```
node bios-check.js --src <BIOS folder> --out <folder> [--stage] [--dat <System.dat>]
```

Verdicts: `OK`, `DAMAGED ZIP`, `DIFFERENT VERSION`, `DIFFERENT VERSION OR DAMAGED`, `MISSING`.
It writes `bios_check.csv`; with `--stage` it copies the good files into `bios-verified/` under the
names and folders the cores expect.

## missing-all.js

Runs `rom-verify.js --missing` for a list of systems and prints one completeness line per system.
It is written for one person's folder layout (staging folders under `~/Downloads`), so edit the
`systems` list at the top to match yours. Keep it in the same folder as `rom-verify.js`.

```
node missing-all.js
```

## Background

Built while rebuilding a RetroPie SD card on a Raspberry Pi 3B. A set of ROMs that looks fine can be
silently damaged (zips with bad CRCs, CHD files that fail `chdman verify`), so these tools check
every file instead of trusting file names.
