import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
export function replayIndependently(source, expectedCount) {
  const script = `import sys,json
from pokerkit import HandHistory,Automation
hands=list(HandHistory.loads_all(sys.stdin.read()))
summary={'hands':len(hands),'actions':0,'zero_cost_runout_checks':0,'odd_chip_normalizations':0,'pot_boundary_normalizations':0}
for hand in hands:
    # Let the PHH iterator perform these operations one at a time so we can
    # preserve PokerKit's pots before HandKilling removes losing contenders.
    # That removal can merge distinct side pots with the same eventual winners.
    hand.automations=tuple(a for a in hand.automations if a not in (Automation.HAND_KILLING,Automation.CHIPS_PUSHING,Automation.CHIPS_PULLING))
    seen=0
    adjustments=[0]*len(hand.starting_stacks)
    inserted_checks=0
    original_pots=None
    next_pot=0
    for state,action in hand.state_actions:
        if original_pots is None and (state.can_kill_hand() or state.can_push_chips()):
            assert hand.variant=='NT' and state.board_count==1,(hand.hand,'only single-board holdem normalization is supported')
            original_pots=[(p.unraked_amount,p.player_indices) for p in state.pots]
        added=state.operations[seen:]
        seen=len(state.operations)
        for op in added:
            name=type(op).__name__
            if action is None and name in {'Folding','CheckingOrCalling','CompletionBettingOrRaisingTo'}:
                # BBPoker skips the pointless zero-cost check when no second
                # player can wager. No paid action or fold may be invented.
                assert name=='CheckingOrCalling' and op.amount==0,(hand.hand,'invented paid action',op,hand.actions,[str(o) for o in state.operations])
                assert sum(s and c>0 for s,c in zip(state.statuses,state.stacks))<=1,(hand.hand,'invented check with a responder')
                inserted_checks+=1
            if name=='ChipsPushing':
                # PokerKit awards all odd chips to the first winner. BBPoker
                # distributes one each clockwise for each original pot. Both
                # original pot amounts/eligibility and winners come exclusively
                # from PokerKit; no BBPoker result is used to derive payouts.
                assert original_pots is not None,(hand.hand,'missing original pots')
                winners=[i for i,a in enumerate(op.amounts) if a>0]
                total=sum(op.amounts)
                quotient,remainder=divmod(total,len(winners))
                assert quotient>0,(hand.hand,'zero-share comparison needs a separate oracle')
                assert [op.amounts[i] for i in winners]==[quotient+remainder]+[quotient]*(len(winners)-1)
                normalized=[0]*len(winners)
                consumed=0
                while consumed<total:
                    assert next_pot<len(original_pots),(hand.hand,'extra pushed pot',op)
                    amount,eligible=original_pots[next_pot]
                    next_pot+=1
                    consumed+=amount
                    assert consumed<=total and set(winners)<=set(eligible),(hand.hand,'incompatible merged pot',op,amount,eligible)
                    quotient,remainder=divmod(amount,len(winners))
                    assert quotient>0,(hand.hand,'zero-share comparison needs a separate oracle')
                    for k in range(len(winners)):
                        normalized[k]+=quotient+(k<remainder)
                    summary['odd_chip_normalizations']+=remainder>1
                quotient,remainder=divmod(total,len(winners))
                summary['pot_boundary_normalizations']+=normalized!=[quotient+(k<remainder) for k in range(len(winners))]
                for k,i in enumerate(winners):
                    adjustments[i]+=normalized[k]-op.amounts[i]
    assert not state.status,(hand.hand,'unfinished')
    assert original_pots is not None and next_pot==len(original_pots),(hand.hand,'unpaid original pot')
    normalized=[a+b for a,b in zip(state.stacks,adjustments)]
    assert normalized==hand.finishing_stacks,(hand.hand,normalized,hand.finishing_stacks,hand.actions)
    expected=sum(len(a.split())>1 and a.split()[1] in {'f','cc','cbr'} for a in hand.actions)
    played=sum(type(op).__name__ in {'Folding','CheckingOrCalling','CompletionBettingOrRaisingTo'} for op in state.operations)
    assert played==expected+inserted_checks,(hand.hand,'implicit action',played,expected,inserted_checks)
    summary['actions']+=expected
    summary['zero_cost_runout_checks']+=inserted_checks
print(json.dumps(summary))
`;
  const result = spawnSync(process.env.POKERKIT_PYTHON, ['-c', script], { input: source, encoding: 'utf8', maxBuffer: 16*1024*1024, timeout: 90000 });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}`);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.hands, expectedCount);
  return summary;
}
