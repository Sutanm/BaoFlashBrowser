'use strict';

function word(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function rect(width, height) {
  const n = 1 + Math.ceil(Math.log2(Math.max(width, height) + 1));
  const bits = [n.toString(2).padStart(5, '0'), ...[0, width, 0, height].map(
    (value) => value.toString(2).padStart(n, '0'),
  )].join('');
  return Buffer.from(bits.padEnd(Math.ceil(bits.length / 8) * 8, '0').match(/.{8}/g).map(
    (byte) => Number.parseInt(byte, 2),
  ));
}

function tag(code, payload = Buffer.alloc(0)) {
  return Buffer.concat([word((code << 6) | payload.length), payload]);
}

module.exports = function flashTextField() {
  const font = Buffer.concat([
    word(2), Buffer.from([0, 0, 5]), Buffer.from('_sans'), word(0), // device font, no glyph table
  ]);
  const field = Buffer.concat([
    word(1), rect(4380, 820), Buffer.from([0x85, 0x08]), // text, color, font, border
    word(2), word(380), Buffer.from([0, 0, 0, 255]),
    Buffer.from('imeText\0\0'),
  ]);
  const data = Buffer.concat([
    rect(4400, 840), word(30 << 8), word(1),
    tag(69, Buffer.alloc(4)), // AVM1
    tag(9, Buffer.from([235, 245, 240])),
    tag(48, font), // DefineFont2
    tag(37, field), // DefineEditText
    tag(26, Buffer.from([6, 1, 0, 1, 0, 0])), // PlaceObject2, identity matrix
    tag(1), tag(0),
  ]);
  const header = Buffer.from([70, 87, 83, 8, 0, 0, 0, 0]);
  header.writeUInt32LE(header.length + data.length, 4);
  return Buffer.concat([header, data]);
};
