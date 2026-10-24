/**
 * dsh-font-studio / 宿主侧字体枚举
 *
 * 浏览器那套 `navigator.queryLocalFonts()` 在 Electron 里常年缺席，canvas 字宽探测又只能
 * 验证「目录里已有的名字」。要真的把本机字体（尤其是 .ttc / .otc / 超级 TTC 这种一个文件
 * 里塞几十个字面的集合）列出来，只能回到宿主进程里读文件 —— 也就是这个模块。
 *
 * 做法：扫系统字体目录与用户字体目录，对每个字体文件只读「文件头 + 表目录 + name 表」
 * 这几 KB（绝不整文件读入：Noto CJK 的 super TTC 动辄上百 MB），从 name 表里取出
 * nameID 1（家族名）与 nameID 16（排版家族名）。ttcf 集合逐个字面解析，因此 TTC 里的
 * 每一个字体都能单独列出来，这正是 CSS 里能直接用的家族名。
 */

import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 允许读取的字体扩展名（.superttc 是各家字体站给「超集 TTC」的自定义后缀，容器仍是 ttcf）。 */
const FONT_EXTENSIONS = [".ttf", ".ttc", ".otf", ".otc", ".superttc", ".ttcf"];

/** name 表最大读取量：超过这个尺寸的文件直接放弃（防御畸形文件）。 */
const MAX_NAME_TABLE = 1 << 20;

/** 一个字体文件里最多解析多少个字面（super TTC 一般几十个，256 足够）。 */
const MAX_FACES = 256;

/** 枚举结果缓存时间：字体安装是低频操作，10 分钟内复用。 */
const CACHE_TTL_MS = 10 * 60 * 1000;

let cache = null;

function readAt(fd, position, length) {
  const buffer = Buffer.allocUnsafe(length);
  const read = readSync(fd, buffer, 0, length, position);
  return read === length ? buffer : buffer.subarray(0, read);
}

/** 解一条 name 表记录的字面文本；platform 3/0 是 UTF-16BE，platform 1 是 Mac Roman。 */
function decodeName(raw, platformID) {
  if (platformID === 3 || platformID === 0) {
    if (raw.length % 2 !== 0) return "";
    return Buffer.from(raw).swap16().toString("utf16le");
  }
  return raw.toString("latin1");
}

/**
 * 解析一张 name 表，返回该字面的家族名。
 *
 * 只用 nameID 16（排版家族名）或退化到 nameID 1（家族名）：前者把 Light/Medium 这类字重
 * 从家族名里摘出去，正是 CSS 想要的粒度。
 * 每种名字同时收简体中文（lang 0x804）与英文（lang 0x409）：Windows 上 DirectWrite 暴露的
 * 家族名随系统语言变化，两个都带上，客户端拼字体栈时 English 名字就当别名兜底。
 *
 * @returns {{ name: string, alias: string } | null}
 */
function decodeNameTable(table) {
  if (table.length < 6) return null;
  const count = table.readUInt16BE(2);
  const storage = table.readUInt16BE(4);
  /** @type {Map<number, { zh: Set<string>, en: Set<string>, other: Set<string> }>} */
  const byNameId = new Map();

  for (let i = 0; i < count && i < 512; i += 1) {
    const base = 6 + i * 12;
    if (base + 12 > table.length) break;
    const platformID = table.readUInt16BE(base);
    const languageID = table.readUInt16BE(base + 4);
    const nameID = table.readUInt16BE(base + 6);
    const length = table.readUInt16BE(base + 8);
    const offset = table.readUInt16BE(base + 10);
    if (nameID !== 1 && nameID !== 16) continue;
    const start = storage + offset;
    if (start + length > table.length) continue;
    const value = decodeName(table.subarray(start, start + length), platformID)
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim();
    if (!value) continue;

    let bucket = byNameId.get(nameID);
    if (!bucket) {
      bucket = { zh: new Set(), en: new Set(), other: new Set() };
      byNameId.set(nameID, bucket);
    }
    if (platformID === 3 && languageID === 0x804) bucket.zh.add(value);
    else if (platformID === 3 && languageID === 0x409) bucket.en.add(value);
    else bucket.other.add(value);
  }

  const pick = (set) => (set.size ? [...set][0] : "");
  for (const nameID of [16, 1]) {
    const bucket = byNameId.get(nameID);
    if (!bucket) continue;
    const zh = pick(bucket.zh);
    const en = pick(bucket.en) || pick(bucket.other);
    const primary = zh || en;
    if (!primary) continue;
    return { name: primary, alias: en && en !== primary ? en : "" };
  }
  return null;
}

/** 从文件偏移处的一个 sfnt 字面里取家族名。 */
function faceFamily(fd, faceOffset) {
  const header = readAt(fd, faceOffset, 12);
  if (header.length < 12) return null;
  const numTables = header.readUInt16BE(4);
  if (!numTables || numTables > 64) return null;
  const directory = readAt(fd, faceOffset + 12, numTables * 16);
  if (directory.length < numTables * 16) return null;

  let nameOffset = 0;
  let nameLength = 0;
  for (let i = 0; i < numTables; i += 1) {
    const record = directory.subarray(i * 16, i * 16 + 16);
    if (record.toString("latin1", 0, 4) !== "name") continue;
    nameOffset = record.readUInt32BE(8);
    nameLength = record.readUInt32BE(12);
    break;
  }
  if (!nameOffset || !nameLength || nameLength > MAX_NAME_TABLE) return null;

  return decodeNameTable(readAt(fd, nameOffset, nameLength));
}

/**
 * 读一个字体文件里的全部家族名。
 * .ttc / .otc / super TTC 是集合，逐个字面解析 —— 一个文件里几十个字体都会单独列出。
 * @returns {{ name: string, alias: string }[]}
 */
export function familiesFromFile(file) {
  let fd;
  try {
    fd = openSync(file, "r");
  } catch {
    return [];
  }
  try {
    const head = readAt(fd, 0, 16);
    if (head.length < 12) return [];
    const tag = head.toString("latin1", 0, 4);
    let offsets = [];

    if (tag === "ttcf") {
      const count = Math.min(head.readUInt32BE(8) || 0, MAX_FACES);
      const table = readAt(fd, 12, count * 4);
      for (let i = 0; i < count; i += 1) {
        if ((i + 1) * 4 <= table.length) offsets.push(table.readUInt32BE(i * 4));
      }
    } else if (tag === "OTTO" || tag === "true" || tag === "typ1" || head.readUInt32BE(0) === 0x00010000) {
      offsets = [0];
    }

    const found = [];
    const seen = new Set();
    for (const offset of offsets) {
      const family = faceFamily(fd, offset);
      if (!family || seen.has(family.name)) continue;
      seen.add(family.name);
      found.push(family);
    }
    return found;
  } catch {
    return [];
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* 已经关掉了 */
    }
  }
}

/** 该扫描的字体目录：系统 Fonts + 当前用户 Fonts（用户装的字体不在系统目录里）。 */
export function fontDirs() {
  const dirs = [];
  const windows = process.env.WINDIR || "C:\\Windows";
  dirs.push(join(windows, "Fonts"));
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) dirs.push(join(localAppData, "Microsoft", "Windows", "Fonts"));
  return dirs;
}

function listFontFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const lower = entry.name.toLowerCase();
    if (!FONT_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue;
    const full = join(dir, entry.name);
    try {
      if (statSync(full).isFile()) files.push(full);
    } catch {
      /* 读不到就跳过（个别系统字体有 ACL） */
    }
  }
  return files;
}

/**
 * 枚举本机字体族。
 * @param {{ refresh?: boolean }} [options] refresh=true 跳过缓存
 * @returns {{ families: { name: string, file: string }[], count: number, dirs: string[], scannedAt: string, errors: string[] }}
 */
export function enumerateFonts(options = {}) {
  const now = Date.now();
  if (!options.refresh && cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const dirs = fontDirs();
  const errors = [];
  const byName = new Map();
  let fileCount = 0;

  for (const dir of dirs) {
    const files = listFontFiles(dir);
    fileCount += files.length;
    for (const file of files) {
      let families = [];
      try {
        families = familiesFromFile(file);
      } catch (error) {
        errors.push(`${file}: ${error && error.message ? error.message : error}`);
        continue;
      }
      for (const family of families) {
        if (!byName.has(family.name)) {
          byName.set(family.name, { name: family.name, alias: family.alias || "", file });
        }
      }
    }
  }

  const families = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));

  const value = {
    families,
    count: families.length,
    files: fileCount,
    dirs,
    scannedAt: new Date(now).toISOString(),
    errors: errors.slice(0, 20)
  };
  cache = { at: now, value };
  return value;
}

/** 测试用：清掉缓存。 */
export function clearFontCache() {
  cache = null;
}
