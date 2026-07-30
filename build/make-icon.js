var sharp = require('sharp');
var pngToIco = require('png-to-ico');
var fs = require('fs');

var sizes = [16, 32, 48, 64, 128, 256];

Promise.all(sizes.map(function(s) {
  return sharp('build/icon.svg').resize(s, s).png().toBuffer();
})).then(function(buffers) {
  fs.writeFileSync('build/icon.png', buffers[buffers.length - 1]);
  console.log('PNG created: build/icon.png');
  return pngToIco.default(buffers);
}).then(function(icoBuf) {
  fs.writeFileSync('build/icon.ico', icoBuf);
  console.log('ICO created: build/icon.ico (' + icoBuf.length + ' bytes, sizes: ' + sizes.join(',') + ')');
}).catch(function(err) {
  console.error('Error:', err.message);
});
