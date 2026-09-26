import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {parseImageSize, imageSize, fillImageSizes} from '../server/image-size.js';
import {parseFragment} from '../server/document.js';

test('parseImageSize reads PNG, GIF, JPEG and WebP headers',()=>{
  const png=Buffer.alloc(24);png.write('\x89PNG\r\n\x1a\n','latin1');png.writeUInt32BE(13,8);png.write('IHDR',12,'latin1');png.writeUInt32BE(850,16);png.writeUInt32BE(946,20);
  assert.deepEqual(parseImageSize(png),{width:850,height:946});
  const gif=Buffer.from('GIF89a\x40\x01\xf0\x00','latin1');
  assert.deepEqual(parseImageSize(gif),{width:320,height:240});
  const jpeg=Buffer.from([0xff,0xd8,0xff,0xe0,0,4,0,0,0xff,0xc0,0,17,8,0x02,0x58,0x03,0x20,3,1,0x22,0,2,0x11,1,3,0x11,1]);
  assert.deepEqual(parseImageSize(jpeg),{width:800,height:600});
  const webp=Buffer.alloc(30);webp.write('RIFF','latin1');webp.write('WEBP',8,'latin1');webp.write('VP8 ',12,'latin1');webp.writeUInt16LE(640,26);webp.writeUInt16LE(480,28);
  assert.deepEqual(parseImageSize(webp),{width:640,height:480});
  assert.equal(parseImageSize(Buffer.from('not an image')),null);
});
test('fillImageSizes adds width/height to book images that lack them',async()=>{
  const bookDir=path.resolve('data/books/bees');
  const known=await imageSize(path.join(bookDir,'img/frontispiece.png'));
  assert.ok(known.width>0&&known.height>0);
  const root=parseFragment('<p><img src="/books/bees/img/frontispiece.png" alt=""><img src="/books/bees/img/frontispiece.png" width="10" height="20" alt=""><img src="/books/bees/img/missing.png" alt=""></p>');
  assert.equal(await fillImageSizes(root,bookDir),true);
  const imgs=[...root.querySelectorAll('img')];
  assert.equal(imgs[0].getAttribute('width'),String(known.width));assert.equal(imgs[0].getAttribute('height'),String(known.height));
  assert.equal(imgs[1].getAttribute('width'),'10');
  assert.equal(imgs[2].getAttribute('width'),null);
  assert.equal(await fillImageSizes(root,bookDir),false);
});
