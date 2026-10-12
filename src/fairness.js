import { createHash, randomBytes } from 'node:crypto';

export const VERIFICATION_VERSION = 'tz-merkle-sha256-v1';
export const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');

/** Salted leaves prevent a 52-card dictionary attack. Padding makes a 64-leaf tree.
 * The root commits to the complete deck before any betting action.
 * Selective proofs preserve folded cards. They prove commitment consistency only,
 * not a zero-knowledge proof of honest entropy, unbiased initial selection or
 * the impossibility of a malicious operator aborting a hand.
 */
export function commitDeck(hand) {
  const salts = Array.from({ length: 64 }, () => randomBytes(32).toString('hex'));
  const leaves = salts.map((salt, i) => hash(`${hand.id}:${i}:${hand.deck[i] ?? 'padding'}:${salt}`));
  const levels = [leaves];
  while (levels.at(-1).length > 1) {
    const row = levels.at(-1), next = [];
    for (let i = 0; i < row.length; i += 2) next.push(hash(row[i] + row[i + 1]));
    levels.push(next);
  }
  return { root: levels.at(-1)[0], salts, levels, version: VERIFICATION_VERSION };
}

export function cardProof(hand, position) {
  if (!Number.isInteger(position) || position < 0 || position >= 52) throw new Error('无效牌位置');
  const proof = { position, card: hand.deck[position], salt: hand.audit.salts[position], siblings: [] };
  let i = position;
  for (const row of hand.audit.levels.slice(0, -1)) {
    proof.siblings.push({ side: i % 2 === 0 ? 'right' : 'left', hash: row[i ^ 1] });
    i = Math.floor(i / 2);
  }
  return proof;
}

export function verifyProof(handId, root, proof) {
  let value = hash(`${handId}:${proof.position}:${proof.card}:${proof.salt}`);
  for (const sibling of proof.siblings) value = hash(sibling.side === 'left' ? sibling.hash + value : value + sibling.hash);
  return value === root;
}

export const fairnessInfo = {
  version: VERIFICATION_VERSION,
  summary: [
    '使用 Node.js 系统密码学安全随机源 crypto.randomInt，配合 Fisher–Yates 无偏洗牌。',
    '洗牌函数不接收注册时间、历史输赢或玩家画像。每手牌独立洗牌，小游戏不修改牌序。',
    '发牌前固定整副牌的加盐 Merkle 承诺。只对本人底牌、公共牌及主动公开/摊牌的牌提供校验材料。',
    '不公开整副牌或随机种子；弃牌底牌不发送给其他玩家，牌局存档以 AES-256-GCM 加密保存。',
    '断线和服务器重启从已保存牌局恢复，不重新洗牌。小游戏输赢与普通德州分开统计。'
  ],
  limits: [
    '承诺校验只能证明可见牌与已承诺牌序一致，不能独立证明服务器最初没有挑牌或线上程序与源码相同。',
    '第一版为中心化服务器。服务器进程可知牌序，持有服务器密钥的人可解密存档；这不是运营者不可见的加密扑克。',
    '尚未实现多方洗牌、零知识公平性证明或第三方审计。不以统计测试宣称绝对公平。'
  ],
  sourceUrls: [
    { label: '查看洗牌、比牌与分池代码', url: '/api/source/poker.js' },
    { label: '查看发牌指纹校验代码', url: '/api/source/fairness.js' },
    { label: 'GitHub 完整源码', url: 'https://github.com/ningqm/BBPoker' },
  ],
};
