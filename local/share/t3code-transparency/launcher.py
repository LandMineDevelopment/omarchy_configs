#!/usr/bin/python3
"""Cache a locally patched T3 AppDir, leaving its official updater target intact."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent
SOURCE = Path.home() / '.local/opt/t3code-nightly/T3-Code.AppImage'
LAUNCHER = Path.home() / '.local/bin/t3code-transparent'
CACHE = Path.home() / '.cache/t3code-transparency'
MAIN = 'apps/desktop/dist-electron/main.cjs'
HOOK = 'apps/desktop/dist-electron/local-transparency.cjs'


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def entries(header: dict, prefix: str = ''):
    for name, entry in header['files'].items():
        path = prefix + name
        if 'files' in entry:
            yield from entries(entry, path + '/')
        else:
            yield path, entry


def read_header(f):
    preamble = f.read(16)
    if len(preamble) != 16:
        raise ValueError('Truncated ASAR header')
    size_payload, header_size, header_payload, json_size = struct.unpack('<4I', preamble)
    if size_payload != 4 or header_payload + 4 != header_size or json_size > header_payload - 4:
        raise ValueError('Unsupported ASAR header')
    return json.loads(f.read(json_size)), 8 + header_size


def integrity(data: bytes) -> dict:
    size = 4 * 1024 * 1024
    return {'algorithm': 'SHA256', 'hash': hashlib.sha256(data).hexdigest(),
            'blockSize': size,
            'blocks': [hashlib.sha256(data[i:i + size]).hexdigest()
                       for i in range(0, len(data), size)]}


def patch_main(source: str) -> str:
    target = 'new electron.BrowserWindow(options)'
    if source.count(target) != 1:
        raise ValueError('T3 window constructor changed; patch needs review')
    if 'minWidth: 840' not in source or 'minHeight: 620' not in source:
        raise ValueError('T3 main-window signature changed; patch needs review')
    source = source.replace(target,
        'require("./local-transparency.cjs").createWindow(electron, options)')
    for target, replacement in (
        ('execTarget: process.env.APPIMAGE?.trim() || process.execPath,',
         'execTarget: process.env.T3CODE_TRANSPARENCY_LAUNCHER?.trim() || process.env.APPIMAGE?.trim() || process.execPath,'),
        ('const execTarget = getOrElse(environment.appImagePath, () => process.execPath);',
         'const execTarget = process.env.T3CODE_TRANSPARENCY_LAUNCHER?.trim() || getOrElse(environment.appImagePath, () => process.execPath);'),
    ):
        if source.count(target) != 1:
            raise ValueError('T3 URL-handler registration changed; patch needs review')
        source = source.replace(target, replacement)
    return source


def patch_archive(path: Path):
    with path.open('rb') as original:
        header, base = read_header(original)
        mapping = dict(entries(header))
        main = mapping[MAIN]
        original.seek(base + int(main['offset']))
        modified = patch_main(original.read(main['size']).decode()).encode()
        replacements = {MAIN: modified, HOOK: (ROOT / 'local-transparency.cjs').read_bytes()}
        directory = header
        for part in HOOK.split('/')[:-1]:
            directory = directory['files'][part]
        directory['files'][HOOK.split('/')[-1]] = {}
        offset = 0
        spans = []
        for name, entry in entries(header):
            if entry.get('unpacked') or 'link' in entry:
                continue
            old_offset, old_size = int(entry.get('offset', 0)), entry.get('size', 0)
            if name in replacements:
                data = replacements[name]
                entry.update(size=len(data), integrity=integrity(data))
            else:
                data = None
            entry['offset'] = str(offset)
            offset += entry['size']
            spans.append((old_offset, old_size, data))
        raw = json.dumps(header, separators=(',', ':'), ensure_ascii=False).encode()
        padding = bytes((-len(raw)) % 4)
        payload = struct.pack('<I', len(raw)) + raw + padding
        pickle = struct.pack('<I', len(payload)) + payload
        output = path.with_suffix('.asar.tmp')
        with output.open('wb') as out:
            out.write(struct.pack('<2I', 4, len(pickle)))
            out.write(pickle)
            for old_offset, old_size, data in spans:
                if data is None:
                    original.seek(base + old_offset)
                    remaining = old_size
                    while remaining:
                        chunk = original.read(min(remaining, 1024 * 1024))
                        if not chunk:
                            raise ValueError('Truncated ASAR file')
                        out.write(chunk)
                        remaining -= len(chunk)
                else:
                    out.write(data)
    output.replace(path)


def prepare() -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    with (CACHE / 'build.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        source_hash = digest(SOURCE)
        patch_hash = hashlib.sha256(
            Path(__file__).read_bytes() + (ROOT / 'local-transparency.cjs').read_bytes()
        ).hexdigest()
        destination = CACHE / (source_hash[:16] + '-' + patch_hash[:12])
        if (destination / 'ready.json').exists():
            return destination / 'squashfs-root'
        with tempfile.TemporaryDirectory(prefix='build-', dir=CACHE) as scratch:
            temp = Path(scratch)
            image = temp / 'source.AppImage'
            shutil.copy2(SOURCE, image)
            if digest(image) != source_hash:
                raise ValueError('Official AppImage changed during preparation; launch again')
            env = clean_environment()
            subprocess.run([str(image), '--appimage-extract'], cwd=temp, env=env,
                           check=True, stdout=subprocess.DEVNULL)
            appdir = temp / 'squashfs-root'
            patch_archive(appdir / 'resources/app.asar')
            # Do not keep another 160 MB copy of the official update target.
            image.unlink()
            (temp / 'ready.json').write_text(json.dumps({
                'source': str(SOURCE), 'source_sha256': source_hash,
                'patch_sha256': patch_hash,
            }) + '\n')
            if destination.exists():
                shutil.rmtree(destination)
            # TemporaryDirectory tolerates its path having been renamed.
            temp.rename(destination)
        return destination / 'squashfs-root'


def clean_environment() -> dict[str, str]:
    env = os.environ.copy()
    for key in ('APPDIR', 'APPIMAGE', 'APPIMAGE_EXIT_AFTER_INSTALL',
                'APPIMAGE_SILENT_INSTALL', 'LD_LIBRARY_PATH', 'LD_PRELOAD',
                'ELECTRON_RUN_AS_NODE'):
        env.pop(key, None)
    return env


def main() -> int:
    args = sys.argv[1:]
    if args == ['--prepare']:
        print(prepare())
        return 0
    env = clean_environment()
    if args == ['--stock']:
        os.execve(str(SOURCE), [str(SOURCE)], env)
    try:
        appdir = prepare()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f'[local-transparency] {error}; opening official T3 Code.', file=sys.stderr)
        os.execve(str(SOURCE), [str(SOURCE), *args], env)
    env.update(APPIMAGE=str(SOURCE), APPDIR=str(appdir),
               T3CODE_TRANSPARENCY_LAUNCHER=str(LAUNCHER))
    os.execve(str(appdir / 'AppRun'), [str(appdir / 'AppRun'), *args], env)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
