/**
 * dsh-font-studio — 宿主侧字体解析单测（node test/fonts.test.mjs）
 *
 * 不依赖本机装了什么字体：现场拼出最小 sfnt / ttcf 二进制，验证
 *   ① 单个 ttf 的家族名解析（中英文名各取一个，英文名进 alias）
 *   ② .ttc / super TTC 集合里**每个字面**都能单独列出来
 *   ③ 中英同名时不产生重复别名
 *   ④ 破损文件不抛错（返回空数组）
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { familiesFromFile } from "../lib/fonts.js";

const be16 = (value) => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value & 0xffff);
  return buffer;
};
const be32 = (value) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
};
const beUtf16 = (text) => Buffer.from(Buffer.from(text, "utf16le")).swap16();

/** 拼一张 name 表：platformID 3 用 UTF-16BE，其它按 latin1。 */
function buildNameTable(entries) {
  const encoded = entries.map((entry) =>
    entry.platformID === 3 ? beUtf16(entry.text) : Buffer.from(entry.text, "latin1")
  );
  const headerSize = 6 + entries.length * 12;
  let offset = 0;
  const records = entries.map((entry, index) => {
    const buffer = encoded[index];
    const record = Buffer.concat([
      be16(entry.platformID),
      be16(1),
      be16(entry.languageID),
      be16(entry.nameID),
      be16(buffer.length),
      be16(offset)
    ]);
    offset += buffer.length;
    return record;
  });
  return Buffer.concat([be16(0), be16(entries.length), be16(headerSize), ...records, ...encoded]);
}

/** 拼一个最小 sfnt 字面（只有一张 name 表），表偏移按文件绝对位置写。 */
function buildFaceAt(nameTable, baseOffset) {
  const tableOffset = baseOffset + 12 + 16;
  const header = Buffer.concat([be32(0x00010000), be16(1), be16(0), be16(0), be16(0)]);
  const record = Buffer.concat([Buffer.from("name", "latin1"), be32(0), be32(tableOffset), be32(nameTable.length)]);
  return Buffer.concat([header, record, nameTable]);
}

/** 拼一个 ttcf 集合（TTC / super TTC 用的就是这套容器）。 */
function buildTtc(nameTables) {
  const count = nameTables.length;
  const headerLength = 12 + 4 * count;
  const offsets = [];
  let cursor = headerLength;
  for (const table of nameTables) {
    offsets.push(cursor);
    cursor += 28 + table.length;
  }
  const header = Buffer.concat([
    Buffer.from("ttcf", "latin1"),
    be32(0x00010000),
    be32(count),
    ...offsets.map(be32)
  ]);
  return Buffer.concat([header, ...nameTables.map((table, index) => buildFaceAt(table, offsets[index]))]);
}

const dir = mkdtempSync(join(tmpdir(), "dshfs-fonts-"));
const write = (name, buffer) => {
  const file = join(dir, name);
  writeFileSync(file, buffer);
  return file;
};

try {
  /* ① 单个 ttf：中文名当主名，英文名当别名 */
  const single = write(
    "single.ttf",
    buildFaceAt(
      buildNameTable([
        { platformID: 3, languageID: 0x804, nameID: 16, text: "更纱黑体 SC" },
        { platformID: 3, languageID: 0x409, nameID: 16, text: "Sarasa Gothic SC" }
      ]),
      0
    )
  );
  assert.deepEqual(familiesFromFile(single), [{ name: "更纱黑体 SC", alias: "Sarasa Gothic SC" }]);

  /* ② TTC：两个字面各列一次 */
  const ttc = write(
    "collection.ttc",
    buildTtc([
      buildNameTable([
        { platformID: 3, languageID: 0x804, nameID: 16, text: "微软雅黑" },
        { platformID: 3, languageID: 0x409, nameID: 16, text: "Microsoft YaHei" }
      ]),
      buildNameTable([
        { platformID: 3, languageID: 0x804, nameID: 16, text: "微软雅黑 UI" },
        { platformID: 3, languageID: 0x409, nameID: 16, text: "Microsoft YaHei UI" }
      ])
    ])
  );
  assert.deepEqual(familiesFromFile(ttc), [
    { name: "微软雅黑", alias: "Microsoft YaHei" },
    { name: "微软雅黑 UI", alias: "Microsoft YaHei UI" }
  ]);

  /* ③ 只有英文名时 alias 留空（不重复堆一遍） */
  const englishOnly = write(
    "english.ttf",
    buildFaceAt(
      buildNameTable([{ platformID: 3, languageID: 0x409, nameID: 1, text: "Cascadia Code" }]),
      0
    )
  );
  assert.deepEqual(familiesFromFile(englishOnly), [{ name: "Cascadia Code", alias: "" }]);

  /* ④ 只有 nameID 1 时也能解析（退回非排版家族名） */
  const legacy = write(
    "legacy.ttf",
    buildFaceAt(
      buildNameTable([
        { platformID: 1, languageID: 0, nameID: 1, text: "FZLanTingHeiS" },
        { platformID: 3, languageID: 0x804, nameID: 1, text: "方正兰亭黑" }
      ]),
      0
    )
  );
  assert.deepEqual(familiesFromFile(legacy), [{ name: "方正兰亭黑", alias: "FZLanTingHeiS" }]);

  /* ⑤ 破损文件不吃异常 */
  const broken = write("broken.ttc", Buffer.from("ttcf\u0000\u0001\u0000\u0000\u0000\u0000\u0000\u0009", "latin1"));
  assert.deepEqual(familiesFromFile(broken), []);
  assert.deepEqual(familiesFromFile(join(dir, "does-not-exist.ttf")), []);

  console.log("PASS  dsh-font-studio fonts: sfnt 解析 / TTC 多字面 / 别名去重 / 破损容错");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
