const COC_KP_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'skill_check',
      description: 'Perform a COC 7th skill check. Rolls d100 against the skill value at the given difficulty. Returns the roll, threshold, and result (critical_success/extreme_success/hard_success/regular_success/failure/fumble). Use for perception, social, non-combat checks. For combat attack vs dodge/fight back use opposed_check instead. Optional: bonusDice/penaltyDice (0-2), isPush for 孤注一掷 (one retry after failure, cannot use for Luck/SAN/combat).',
      parameters: {
        type: 'object',
        properties: {
          skillName: { type: 'string', description: 'Name of the skill being checked (e.g. "侦查", "格斗", "说服")' },
          skillValue: { type: 'integer', description: 'The investigator\'s skill value (0-99)' },
          difficulty: { type: 'string', enum: ['regular', 'hard', 'extreme'], description: 'Difficulty level. regular=skill value, hard=skill/2, extreme=skill/5' },
          bonusDice: { type: 'integer', description: 'Number of bonus dice (0-2). Lower tens digit is used. Cancels with penaltyDice.' },
          penaltyDice: { type: 'integer', description: 'Number of penalty dice (0-2). Higher tens digit is used. Cancels with bonusDice.' },
          isPush: { type: 'boolean', description: 'True if this is a 孤注一掷 (pushing roll) after a failed check. Not allowed for Luck, SAN, or combat checks.' },
        },
        required: ['skillName', 'skillValue', 'difficulty'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'opposed_check',
      description: 'COC 7th opposed roll. Both sides roll d100; compare success levels (critical_success > extreme > hard > regular > failure > fumble). Tie in level: higher skill value wins. Still tie: use tieBreaker. Optional: sideABonusDice/sideAPenaltyDice, sideBBonusDice/sideBPenaltyDice (0-2 each) for 以多打少 etc. Use for melee combat (attacker vs defender: 反击 = tieBreaker attacker, 闪避 = tieBreaker defender), social contests, etc.',
      parameters: {
        type: 'object',
        properties: {
          sideAName: { type: 'string', description: 'Name of side A (e.g. "调查员格斗")' },
          sideAValue: { type: 'integer', description: 'Skill value of side A (0-99)' },
          sideBName: { type: 'string', description: 'Name of side B (e.g. "NPC闪避")' },
          sideBValue: { type: 'integer', description: 'Skill value of side B (0-99)' },
          tieBreaker: { type: 'string', enum: ['attacker', 'defender'], description: 'If both same success level and same skill value: attacker = side A wins; defender = side B wins. Use attacker for 反击, defender for 闪避.' },
          sideABonusDice: { type: 'integer', description: 'Bonus dice for side A (0-2). Cancels with sideAPenaltyDice.' },
          sideAPenaltyDice: { type: 'integer', description: 'Penalty dice for side A (0-2).' },
          sideBBonusDice: { type: 'integer', description: 'Bonus dice for side B (0-2).' },
          sideBPenaltyDice: { type: 'integer', description: 'Penalty dice for side B (0-2).' },
        },
        required: ['sideAName', 'sideAValue', 'sideBName', 'sideBValue', 'tieBreaker'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'san_check',
      description: 'Perform a COC 7th sanity check. Rolls d100 against current SAN value, then rolls the appropriate loss. Returns the roll, whether it passed, and the SAN lost. Call this when the investigator encounters something horrifying or supernatural.',
      parameters: {
        type: 'object',
        properties: {
          currentSan: { type: 'integer', description: 'Investigator\'s current SAN value' },
          successLoss: { type: 'string', description: 'SAN loss on success (e.g. "0", "1", "1d3")' },
          failureLoss: { type: 'string', description: 'SAN loss on failure (e.g. "1d6", "2d6", "1d10")' },
        },
        required: ['currentSan', 'successLoss', 'failureLoss'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'roll_dice',
      description: 'Roll dice to get a random result. Use for damage rolls, random events, etc. For skill checks, prefer skill_check tool instead. Each call returns a new independent random number.',
      parameters: {
        type: 'object',
        properties: {
          sides: { type: 'integer', description: 'Number of sides (e.g. 6 for d6 damage, 10 for d10). Default 100.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'adjust_hp',
      description: 'Adjust investigator HP. Use negative delta for damage (after armor), positive for healing.',
      parameters: {
        type: 'object',
        properties: { delta: { type: 'integer', description: 'HP change (e.g. -3 for 3 damage, +2 for healing)' } },
        required: ['delta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'first_aid',
      description:
        'Apply COC 7th First Aid effect after a successful 急救检定. If the investigator is dying and wounded, restores 1 HP (not above hpMax) and stabilises them from dying to major wound.',
      parameters: {
        type: 'object',
        properties: {
          success: {
            type: 'boolean',
            description:
              'Whether the First Aid skill check succeeded. If false, HP and dying state do not change (only narrative message). Default true.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'adjust_san',
      description: 'Adjust investigator SAN after a san_check result. Use the loss value returned by san_check as negative delta.',
      parameters: {
        type: 'object',
        properties: { delta: { type: 'integer', description: 'SAN change (e.g. -4 for 4 sanity loss)' } },
        required: ['delta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'adjust_mp',
      description: 'Adjust investigator MP when they cast spells or recover magic points.',
      parameters: {
        type: 'object',
        properties: { delta: { type: 'integer', description: 'MP change (negative for spending)' } },
        required: ['delta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'medicine',
      description:
        'Apply COC 7th Medicine effect after a successful 医学检定 under proper medical care. On success heals 1D3 HP (not above hpMax).',
      parameters: {
        type: 'object',
        properties: {
          success: {
            type: 'boolean',
            description: 'Whether the Medicine skill check succeeded. If false, HP does not change.',
          },
          healExpr: {
            type: 'string',
            description: 'Healing dice expression, default "1d3".',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spend_luck',
      description: 'Spend Luck points (1:1) to reduce a d100 roll result after a skill/attribute check. Cannot be used for Luck check, SAN check, or damage rolls. Cannot change critical/fumble. Call after skill_check when player chooses to spend Luck; pass amount spent. Returns new Luck value.',
      parameters: {
        type: 'object',
        properties: { amount: { type: 'integer', description: 'Luck points to spend (positive integer)' } },
        required: ['amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'transition_scene',
      description: 'Record a scene transition when the investigator moves to a new location mentioned in the story. Use the scene/location name from the story text.',
      parameters: {
        type: 'object',
        properties: {
          sceneName: { type: 'string', description: 'The name of the scene/location (e.g. "昏暗的酒吧", "图书馆二楼")' },
        },
        required: ['sceneName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grant_clue',
      description: 'Grant a clue to the investigator when they discover important information. Use for obvious clues (no check needed) or after a successful investigation. Describe the clue in natural language.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Natural language description of the clue (e.g. "日记本中记载了1923年的神秘仪式")' },
        },
        required: ['description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'end_game',
      description: 'End the scenario and transition the UI to an ending summary screen. Call when the story reaches a clear conclusion (victory/defeat/partial). Must provide a concise but complete ending summary and outcome.',
      parameters: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['victory', 'defeat', 'partial', 'survival', 'unknown'], description: 'Ending outcome type' },
          title: { type: 'string', description: 'Ending title' },
          summary: { type: 'string', description: 'Ending summary (500-900 Chinese chars recommended)' },
          epilogueOptions: { type: 'array', items: { type: 'string' }, description: 'Optional epilogue / follow-up options' },
          keyFacts: { type: 'array', items: { type: 'string' }, description: 'Optional key facts / truths revealed' },
          keyTurnIds: { type: 'array', items: { type: 'string' }, description: 'Optional key turn ids for replay' },
        },
        required: ['outcome', 'title', 'summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'trigger_insanity',
      description: 'After SAN loss (e.g. from san_check), evaluate insanity: permanent if SAN dropped to 0; indefinite if daily SAN loss >= 1/5 of current SAN; if single loss >= 5, INT check—success = temporary insanity (roll bout), failure = 压抑. For temporary/indefinite, 1D10 bout table: 9 = add phobia, 10 = add mania. Call after san_check when SAN was lost.',
      parameters: {
        type: 'object',
        properties: {
          sanLost: { type: 'integer', description: 'SAN just lost in this event' },
          intValue: { type: 'integer', description: 'Investigator INT value for temporary insanity check (when single loss >= 5)' },
        },
        required: ['sanLost', 'intValue'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_major_wound',
      description: 'Apply major wound and dying rules. If damageDealt > hpMax then instant death (立即死亡). Else if damageDealt >= hpMax/2 then major wound (CON check for unconscious). If hpAfter <= 0 and (major wound or instant death) then investigator is dying. Call after damage is applied (adjust_hp).',
      parameters: {
        type: 'object',
        properties: {
          hpMax: { type: 'integer', description: 'Investigator max HP' },
          damageDealt: { type: 'integer', description: 'Damage dealt in this hit (before armor)' },
          hpAfter: { type: 'integer', description: 'HP after this damage (current HP)' },
        },
        required: ['hpMax', 'damageDealt', 'hpAfter'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reset_day',
      description: 'Start a new game day: reset daily SAN loss counter to 0. Call when the investigator rests overnight or when you narrate that a new day has begun. Required for correct 不定性疯狂 (indefinite insanity) triggering on the next day.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'melee_attack',
      description: 'COC 7th melee: opposed check (attacker A vs defender B), then winner deals damage (weapon dice + damage bonus - loser armor). If investigator is the loser, HP and major wound/dying are applied automatically. Use instead of separate opposed_check + roll_dice + adjust_hp + apply_major_wound.',
      parameters: {
        type: 'object',
        properties: {
          sideAName: { type: 'string', description: 'Attacker name (e.g. 调查员格斗)' },
          sideAValue: { type: 'integer', description: 'Attacker skill value (0-99)' },
          sideBName: { type: 'string', description: 'Defender name (e.g. NPC闪避)' },
          sideBValue: { type: 'integer', description: 'Defender skill value (0-99)' },
          tieBreaker: { type: 'string', enum: ['attacker', 'defender'], description: 'attacker = 反击 (A wins tie), defender = 闪避 (B wins tie)' },
          damageExpr: { type: 'string', description: 'Weapon damage dice (e.g. "1d6", "1d8")' },
          attackerDamageBonus: { type: 'string', description: 'Side A damage bonus (e.g. "0", "+1D4")' },
          defenderDamageBonus: { type: 'string', description: 'Side B damage bonus' },
          attackerArmor: { type: 'integer', description: 'Side A armor (damage reduction)' },
          defenderArmor: { type: 'integer', description: 'Side B armor' },
          investigatorSide: { type: 'string', enum: ['A', 'B', 'none'], description: 'Which side is the investigator (A, B, or none for NPC vs NPC)' },
          sideABonusDice: { type: 'integer', description: 'Optional bonus/penalty dice for A (0-2)' },
          sideAPenaltyDice: { type: 'integer' },
          sideBBonusDice: { type: 'integer' },
          sideBPenaltyDice: { type: 'integer' },
        },
        required: ['sideAName', 'sideAValue', 'sideBName', 'sideBValue', 'tieBreaker', 'damageExpr', 'investigatorSide'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ranged_attack',
      description: 'COC 7th ranged: skill check to hit (e.g. 手枪), then on success roll damage and subtract target armor. If targetIsInvestigator, HP and major wound/dying are applied automatically.',
      parameters: {
        type: 'object',
        properties: {
          skillName: { type: 'string', description: 'Ranged skill name (e.g. 手枪, 步枪)' },
          skillValue: { type: 'integer', description: 'Shooter skill value (0-99)' },
          difficulty: { type: 'string', enum: ['regular', 'hard', 'extreme'], description: 'Difficulty (e.g. hard for long range)' },
          damageExpr: { type: 'string', description: 'Weapon damage (e.g. "1d10")' },
          targetArmor: { type: 'integer', description: 'Target armor value' },
          targetIsInvestigator: { type: 'boolean', description: 'True if the investigator is the target (takes damage)' },
        },
        required: ['skillName', 'skillValue', 'damageExpr', 'targetIsInvestigator'],
      },
    },
  },
]

module.exports = { COC_KP_TOOLS }
