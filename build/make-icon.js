var sharp = require('sharp');
var pngToIco = require('png-to-ico');
var fs = require('fs');

sharp('build/icon.svg')
  .resize(256, 256)
  .png()
  .toBuffer()
  .then(function (pngBuf) {
    fs.writeFileSync('build/icon.png', pngBuf);
    console.log('PNG created: build/icon.png');
    return pngToIco.default([pngBuf]);
  })
  .then(function (icoBuf) {
    fs.writeFileSync('build/icon.ico', icoBuf);
    console.log('ICO created: build/icon.ico');
  })
  .catch(function (err) {
    console.error('Error:', err.message);
  });
