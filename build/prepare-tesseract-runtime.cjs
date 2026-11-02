const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { unzipSync } = require('fflate');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'native', 'ocr', 'win32');
const vendor = path.join(root, 'tools', 'ocr-tesseract', 'vendor');
const manifest = require(path.join(vendor, 'manifest.json'));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
if (process.platform !== 'win32') throw new Error('Build the Win32 OCR sidecar on Windows');
const archive = fs.readFileSync(path.join(vendor, 'tesseract-win32.zip'));
if (sha256(archive) !== manifest.archiveSha256) throw new Error('Tesseract vendor archive SHA-256 mismatch');
fs.mkdirSync(target, { recursive: true });
const entries = unzipSync(archive);
for (const [name, hash] of Object.entries(manifest.files)) {
  const file = path.resolve(target, name);
  if (!file.startsWith(`${target}${path.sep}`) || !entries[name] || sha256(entries[name]) !== hash) {
    throw new Error(`Invalid Tesseract vendor file: ${name}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries[name]);
}

const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
const located = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' });
if (located.status !== 0 || !located.stdout.trim()) throw new Error('MSVC x86 C++ tools are required to build the Tesseract sidecar');
const vcvars = path.join(located.stdout.trim(), 'VC', 'Auxiliary', 'Build', 'vcvars32.bat');
const cache = path.join(root, '.cache', 'tesseract-build');
fs.mkdirSync(cache, { recursive: true });
const source = path.join(root, 'tools', 'ocr-tesseract', 'bao_tesseract_sidecar.cpp');
const executable = path.join(target, 'bao-tesseract-ocr-sidecar.exe');
const script = path.join(cache, 'build.cmd');
fs.writeFileSync(script, `@echo off\r\ncall "${vcvars}"\r\nif errorlevel 1 exit /b 1\r\ncl /nologo /std:c++17 /O2 /MT /EHsc /utf-8 /Fo"${path.join(cache, 'sidecar.obj')}" /Fe"${executable}" "${source}"\r\n`);
const build = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'build.cmd'], { stdio: 'inherit', cwd: cache, windowsHide: true });
if (build.status !== 0) throw new Error(`Tesseract sidecar build failed: ${build.error || build.status}`);
fs.writeFileSync(path.join(target, 'OCR-RUNTIME.json'), JSON.stringify({
  protocol: 1, provider: manifest.provider, engine: manifest.engine, model: manifest.model,
  platform: manifest.platform, arch: manifest.arch, modelCommit: manifest.modelCommit,
  files: { ...manifest.files, 'bao-tesseract-ocr-sidecar.exe': sha256(fs.readFileSync(executable)) },
}, null, 2));
console.log(`Prepared x86 Tesseract runtime: ${target}`);
