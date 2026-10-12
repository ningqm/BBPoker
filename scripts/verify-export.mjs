#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { VERIFICATION_VERSION, verifyProof } from '../src/fairness.js';

const HEX = /^[0-9a-f]{64}$/;
const CARD = /^[2-9TJQKA][cdhs]$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const LIMITATION = '校验范围：只证明本文件中的可见牌与本文件中的承诺一致；不证明服务器最初公平发牌、未更换承诺、牌谱完整或其他历史数据真实。';

function requireValid(condition, message) {
  if (!condition) throw new Error(message);
}

function expectedVisibleCards(hand, viewerId) {
  requireValid(Array.isArray(hand.players) && hand.players.length >= 2 && hand.players.length <= 9, '玩家列表无效');
  const ids = new Set(), seats = new Set();
  for (const p of hand.players) {
    requireValid(record(p) && typeof p.id === 'string' && p.id.length > 0 &&
      Number.isSafeInteger(p.seat) && p.seat >= 0 && p.seat <= 8, '玩家或座位格式无效');
    requireValid(!ids.has(p.id) && !seats.has(p.seat), '玩家或座位重复');
    ids.add(p.id); seats.add(p.seat);
    requireValid(Array.isArray(p.cards) && p.cards.length === 2 && p.cards.every(c => c === null || typeof c === 'string' && CARD.test(c)), '底牌格式无效');
    if (p.id === viewerId) requireValid(p.cards.every(c => c !== null), '本人的底牌记录缺失');
  }
  requireValid(ids.has(viewerId), '导出者不在本手玩家列表中');
  requireValid(Array.isArray(hand.board) && [0, 3, 4, 5].includes(hand.board.length) && hand.board.every(c => typeof c === 'string' && CARD.test(c)), '公共牌格式无效');
  requireValid(Array.isArray(hand.log), '行动记录缺失');
  const sbEvents = hand.log.filter(e => record(e) && e.type === 'smallBlind');
  const bbEvents = hand.log.filter(e => record(e) && e.type === 'bigBlind');
  requireValid(sbEvents.length === 1 && bbEvents.length === 1, '无法确定强制盲注与发牌顺序');
  const sbId = sbEvents[0].playerId, bbId = bbEvents[0].playerId;
  requireValid(ids.has(sbId) && ids.has(bbId) && sbId !== bbId, '盲注玩家无效');
  const sorted = [...hand.players].sort((a, b) => a.seat - b.seat);
  const sbIndex = sorted.findIndex(p => p.id === sbId);
  requireValid(sorted[(sbIndex + 1) % sorted.length].id === bbId, '盲注座位顺序不一致');
  // Engine deals clockwise: BB receives first in heads-up, SB in multiway.
  const firstId = sorted.length === 2 ? bbId : sbId;
  const first = sorted.findIndex(p => p.id === firstId);
  const order = [...sorted.slice(first), ...sorted.slice(0, first)];
  const expected = new Map();
  for (let i = 0; i < order.length; i++) for (let card = 0; card < 2; card++) {
    if (order[i].cards[card] !== null) expected.set(i + card * order.length, order[i].cards[card]);
  }
  const start = order.length * 2;
  const boardPositions = [start + 1, start + 2, start + 3, start + 5, start + 7];
  hand.board.forEach((card, i) => expected.set(boardPositions[i], card));
  requireValid(new Set(expected.values()).size === expected.size, '可见牌包含重复牌');
  return expected;
}

/** Verify current export format. No card values, salts or personal IDs are printed. */
export function verifyExport(data) {
  requireValid(record(data) && ['BBPoker', '同桌', 'WPT 公平局'].includes(data.app) && data.version === 1, '不支持的导出格式或版本（需要 BBPoker JSON 版本 1，也支持旧版导出）');
  requireValid(typeof data.viewerId === 'string' && data.viewerId.length > 0 && Array.isArray(data.hands), '导出者或牌谱列表缺失');
  const handIds = new Set();
  let proofCount = 0;
  for (let index = 0; index < data.hands.length; index++) {
    const hand = data.hands[index];
    try {
      requireValid(record(hand) && typeof hand.id === 'string' && hand.id.length > 0, '手牌编号缺失');
      requireValid(!handIds.has(hand.id), '手牌编号重复');
      handIds.add(hand.id);
      requireValid(hand.verificationVersion === VERIFICATION_VERSION, '不支持的承诺验证版本');
      requireValid(typeof hand.commitment === 'string' && HEX.test(hand.commitment), '承诺根格式无效');
      requireValid(Array.isArray(hand.proofs), '证明列表缺失');
      const expected = expectedVisibleCards(hand, data.viewerId);
      const positions = new Set();
      for (const proof of hand.proofs) {
        requireValid(record(proof) && Number.isInteger(proof.position) && proof.position >= 0 && proof.position < 52, '证明的牌位置无效');
        requireValid(!positions.has(proof.position), '证明的牌位置重复');
        positions.add(proof.position);
        requireValid(typeof proof.card === 'string' && CARD.test(proof.card) && typeof proof.salt === 'string' && HEX.test(proof.salt), '证明的牌面或盐值格式无效');
        requireValid(expected.has(proof.position) && expected.get(proof.position) === proof.card, '证明与牌谱可见牌的位置或内容不一致');
        requireValid(Array.isArray(proof.siblings) && proof.siblings.length === 6, '证明路径必须为 6 层');
        let position = proof.position;
        for (const sibling of proof.siblings) {
          requireValid(record(sibling) && typeof sibling.hash === 'string' && HEX.test(sibling.hash) &&
            sibling.side === (position % 2 === 0 ? 'right' : 'left'), '证明路径的方向或哈希格式无效');
          position = Math.floor(position / 2);
        }
        requireValid(verifyProof(hand.id, hand.commitment, proof), '证明与承诺根不匹配');
        proofCount++;
      }
      requireValid(positions.size === expected.size, '部分可见牌缺少证明');
    } catch (error) {
      // Our own validation messages contain neither actual cards nor payload text.
      throw new Error(`第 ${index + 1} 手：${error.message}`);
    }
  }
  return { hands: data.hands.length, proofs: proofCount, verificationVersion: VERIFICATION_VERSION };
}

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('用法：node scripts/verify-export.mjs <导出的 JSON 牌谱文件>');
    console.log(LIMITATION);
    return;
  }
  try {
    requireValid(args.length === 1, '用法：node scripts/verify-export.mjs <导出的 JSON 牌谱文件>');
    let text;
    try { text = await readFile(resolve(args[0]), 'utf8'); }
    catch { throw new Error('无法读取牌谱文件'); }
    let data;
    try { data = JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch { throw new Error('文件不是有效的 JSON 牌谱'); }
    const result = verifyExport(data);
    console.log(`验证通过：${result.hands} 手牌，${result.proofs} 项可见牌证明。`);
    if (!result.hands) console.log('文件中没有牌局，未验证任何发牌记录。');
    console.log(LIMITATION);
    console.log('验证过程完全离线，未输出任何底牌、盐值或个人标识。');
  } catch (error) {
    console.error(`验证失败：${error.message}`);
    console.error(LIMITATION);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main(process.argv.slice(2));
