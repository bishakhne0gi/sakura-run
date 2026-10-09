// FBX (Mixamo) -> compressed GLB, for every character in public/characters/src.
//
//   node pipeline/convert-characters.mjs
//
// Two things here are load-bearing, both learned the hard way:
//   * no --khr-materials-unlit. It makes the materials unlit, gltf-transform's
//     prune then correctly drops the now-unused NORMAL attribute, and a mesh
//     with no normals renders as a solid black silhouette under any lit
//     material.
//   * quantize, not draco. Draco needs a decoder shipped and wired into the
//     loader; quantize is understood by GLTFLoader out of the box and gets
//     within a megabyte of the same size.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import convert from 'fbx2gltf';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'public', 'characters', 'src');
const OUT = path.join(ROOT, 'public', 'characters');

const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.fbx'));
console.log(`converting ${files.length} characters`);

for (const file of files) {
  const name = path.basename(file, '.fbx');
  const raw = path.join(SRC, `${name}.lit.glb`);
  const out = path.join(OUT, `${name}.glb`);
  try {
    await convert(path.join(SRC, file), raw, ['--binary']);
    execFileSync('npx', ['gltf-transform', 'optimize', raw, out,
      '--texture-size', '512', '--compress', 'quantize', '--no-prune'],
      { cwd: ROOT, stdio: 'pipe' });
    const before = fs.statSync(path.join(SRC, file)).size;
    const after = fs.statSync(out).size;
    console.log(`  ${name.padEnd(10)} ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(2)} MB`);
    fs.rmSync(raw, { force: true });
  } catch (error) {
    console.log(`  ${name}: FAILED ${String(error.message || error).slice(0, 120)}`);
  }
}
