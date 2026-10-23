const asar = require('D:/AI_Projects/harness2-zs1-build/ZCode/node_modules/@electron/asar');
const path = process.argv[2];
const all = asar.listPackage(path);
const hosts = all.filter((f) => f.includes('harness2-host') || /host.index.js/.test(f.replace(/[\\]/g, '/')));
console.log('HOST FILES:', hosts.slice(0, 8).join('\n') || '(none)');
try {
  const idx = asar.extractFile(path, 'out/host/index.js').toString();
  console.log('INDEX_HEAD:', JSON.stringify(idx.slice(0, 220)));
} catch (e) {
  console.log('INDEX-EXTRACT-FAIL:', e.message.slice(0, 160));
}
try {
  const h = asar.extractFile(path, 'out/host/harness2-host.cjs').toString();
  console.log(
    'HARNESS2-HOST len=',
    h.length,
    'MARKER=',
    h.includes('zs1-stub host started'),
    'CORE=',
    h.includes('session.v1.jsonl'),
  );
} catch (e) {
  console.log('HOST-EXTRACT-FAIL:', e.message.slice(0, 160));
}
const mainEntry = JSON.parse(asar.extractFile(path, 'package.json').toString());
console.log('PKG main=', mainEntry.main, 'version=', mainEntry.version, 'productName=', mainEntry.productName);
