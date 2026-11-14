"use strict";
// 识别后的确定性对齐：把字幕里明显听错的词，按词库改回正字。
//
// 为什么需要它：whisper 的 prompt 只是提示，模型可以完全不采纳；第三方服务
// 也不提供声学热词表。人名同音、形近的差错占了识别错字的大头，这类差错用
// 确定性规则就能修好，不需要再调一次付费模型，也不会随模型版本漂移。
//
// 两条刹车，宁可漏改也不能改错：
//   1. 只处理「与词库音节数相同、仅差一个字」的片段，且该片段不能是已有常用词；
//   2. 同一句里命中多个候选时直接放弃，避免连锁误改。
// 本模块为本地策略，不对应上游规则；上游靠服务端声学热词，本地没有这条通道。
const fail = message => Object.assign(new Error(message), { statusCode: 400 });

// 常见虚词与高频单字：命中也绝不替换，否则「他今天」会被改成「他今田」这类怪句。
const STOP = new Set([...'的了是在我有和人这中大为上个国到说们地也子时道出而要于就下得可你年生自会那后能对着事其里所去行过家十用发天如然作方成者多日都三小军二无同么经法当起与好看学进种将还分此心前面又定见只主没公从他她它我你咱很就才又再还也吗呢吧啊呀哈嗯哦这那哪谁什么怎怎样么']);

function chars(value) { return [...normalize(value)]; }
function normalize(value) { return String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim(); }

// 同长度、仅一处不同，且不同处不是词库里的字——同音字/形近字最典型的样子。
function near(a, b) {
  const x = chars(a), y = chars(b);
  if (x.length !== y.length || x.length < 2) return 0;
  let diff = -1;
  for (let i = 0; i < x.length; i++) {
    if (x[i] === y[i]) continue;
    if (diff >= 0) return 0;
    diff = i;
  }
  return diff >= 0 ? 1 : 0;
}

function build(glossary, { limit = 500 } = {}) {
  const rows = Array.isArray(glossary) ? glossary : [];
  if (rows.length > limit) throw fail(`词库最多 ${limit} 条`);
  const terms = new Map(); // 正字 -> 可接受的错写长度
  for (const raw of rows) {
    if (!raw || raw.enabled === false) continue;
    const canonical = normalize(raw.term);
    if (!canonical || chars(canonical).length < 2) continue;
    terms.set(canonical, chars(canonical).length);
    for (const alias of String(raw.aliases ?? '').split(',')) {
      const extra = normalize(alias);
      if (extra && chars(extra).length >= 2) terms.set(extra, chars(extra).length);
    }
  }
  return [...terms.keys()];
}

// 返回 { text, changes }：changes 为 0 时调用方应保留原文对象引用不变。
function apply(text, vocabulary) {
  const source = String(text ?? '');
  if (!source || !Array.isArray(vocabulary) || !vocabulary.length) return { text: source, changes: 0 };
  const pool = vocabulary.filter(t => !source.includes(t));
  if (!pool.length) return { text: source, changes: 0 };
  let output = source, changes = 0;
  for (const term of pool) {
    const size = chars(term).length;
    const segs = [...output].length;
    if (size > segs) continue;
    const candidates = [];
    for (let i = 0; i + size <= segs; i++) {
      const piece = [...output].slice(i, i + size).join('');
      // 首字或末字是高频率虚词的片段不替换：句子里最常见的错位都发生在这里，
      // 宁可漏改一个人名，也不能把「他今天」改成「他今田」。
      const head = piece[0], tail = piece[piece.length - 1];
      if (STOP.has(head) || STOP.has(tail)) continue;
      if (near(piece, term)) candidates.push({ at: i, piece });
    }
    if (candidates.length !== 1) continue; // 零处或多处一律不动
    const { at, piece } = candidates[0];
    const head = [...output];
    head.splice(at, size, ...chars(term));
    output = head.join('');
    changes += 1;
  }
  return { text: output, changes };
}

module.exports = { build, apply, near, STOP };
