/**
 * COC KP tool definitions — SINGLE SOURCE OF TRUTH (Task 10).
 *
 * Migrated verbatim from `shared/tools/cocTools.cjs` (which itself was
 * extracted byte-identical from `original/ai-trpg-web/electron/ipc/
 * aiHandlers.cjs` COC_KP_TOOLS in Task 1). name/description/parameters are
 * preserved word-for-word — do not "improve" wording, it must stay aligned
 * with the server-side AI function-calling semantics and prompt wording.
 *
 * Consumers:
 *  - server (kpAgentService → chatForAgent tools, aiService ChatTool type)
 *  - client (toolCalling orchestrator name validation, consistency tests)
 */

export interface KpToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export const COC_KP_TOOLS: KpToolDef[] = [
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
          sceneId: { type: 'string', description: 'Optional structured scene id from the script (when known)' },
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
          clueId: { type: 'string', description: 'Optional structured clue id from the script (when known)' },
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
          isImpaling: { type: 'boolean', description: 'True for impaling weapons (blades, spears): on an extreme success the damage dice AND damage bonus are maxed, plus one extra roll of the weapon damage. Non-impaling (blunt) weapons max the dice and bonus only. Omit for normal damage.' },
        },
        required: ['sideAName', 'sideAValue', 'sideBName', 'sideBValue', 'tieBreaker', 'damageExpr', 'investigatorSide'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ranged_attack',
      description: 'COC 7th ranged: skill check to hit (e.g. 手枪), then on success roll damage and subtract target armor. If targetIsInvestigator, HP and major wound/dying are applied automatically. Extreme success deals impaling damage (see isImpaling).',
      parameters: {
        type: 'object',
        properties: {
          skillName: { type: 'string', description: 'Ranged skill name (e.g. 手枪, 步枪)' },
          skillValue: { type: 'integer', description: 'Shooter skill value (0-99)' },
          difficulty: { type: 'string', enum: ['regular', 'hard', 'extreme'], description: 'Difficulty (e.g. hard for long range)' },
          damageExpr: { type: 'string', description: 'Weapon damage (e.g. "1d10")' },
          targetArmor: { type: 'integer', description: 'Target armor value' },
          targetIsInvestigator: { type: 'boolean', description: 'True if the investigator is the target (takes damage)' },
          bonusDice: { type: 'integer', description: 'Bonus dice (0-2): point-blank, aiming, larger target' },
          penaltyDice: { type: 'integer', description: 'Penalty dice (0-2): cover, firing into melee, moving target, handgun burst' },
          damageBonus: { type: 'string', description: 'Damage bonus for thrown weapons / bows (half DB added to damage). Omit for firearms.' },
          isImpaling: { type: 'boolean', description: 'True for bullets/arrows/other impaling projectiles: extreme success maxes damage (and bonus) plus one extra weapon-damage roll; beyond extreme range only a critical (01) impales.' },
        },
        required: ['skillName', 'skillValue', 'damageExpr', 'targetIsInvestigator'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspiration_check',
      description: 'COC 7th 灵感检定 (idea roll): an INT check whose difficulty is INVERTED by how much the clue was mentioned (never mentioned → regular; mentioned not emphasized → hard; already pointed out/discussed → extreme). Success or failure BOTH advance the story: success weaves the clue into the narrative; failure gives the clue anyway while putting the investigator in the worst possible spot ("千钧一发"). Use when the party is stuck or missed a key clue.',
      parameters: {
        type: 'object',
        properties: {
          skillValue: { type: 'integer', description: 'The investigator INT value (0-99)' },
          difficulty: { type: 'string', enum: ['regular', 'hard', 'extreme'], description: 'Inverted difficulty by clue mention (see description)' },
          clueDescription: { type: 'string', description: 'The clue that surfaces (given on both success and failure)' },
          setback: { type: 'string', description: 'On failure: the additional setback that puts the investigator in a worse position' },
        },
        required: ['skillValue', 'clueDescription'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cast_spell',
      description: 'COC 7th 施法: deduct MP (overflow into HP 1:1), on FIRST cast require a hard POW check (success → spell works; failure → may push; pushed failure → spell STILL works but caster pays 1D6× the cost as backlash). A spell always succeeds when cast; the check only measures how badly the caster is hurt. Interrupted casting still pays the costs. Non-believers cannot cast.',
      parameters: {
        type: 'object',
        properties: {
          spellName: { type: 'string', description: 'Name of the spell (use its in-world alias, not the rulebook name)' },
          costMp: { type: 'integer', description: 'MP cost (deducted; overflow reduces HP 1:1)' },
          costSan: { type: 'integer', description: 'SAN cost paid when casting' },
          costPow: { type: 'integer', description: 'Optional POW cost (if the spell demands it)' },
          powValue: { type: 'integer', description: 'Caster POW value (0-99), used for the hard POW check' },
          firstCast: { type: 'boolean', description: 'True if casting this spell for the first time (requires the hard POW check). Omit/false for repeat casts.' },
          push: { type: 'boolean', description: 'True if pushing after a failed first-cast check (backlash 1D6× cost)' },
        },
        required: ['spellName', 'costMp', 'costSan', 'powValue'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_tome',
      description: 'COC 7th 阅读神话典籍: browse (泛读) grants the tome\'s CMI mythos gain + automatic SAN loss (no check) + reveals contained spells; study (精读, months) compares the reader\'s mythos to the tome\'s MR: below MR gains CMF, at/above gains only CMI, plus language growth marks; consult (查资料) is a 1D100 ≤ MR roll to find mythos knowledge. Reading loss can trigger insanity; non-believers lose max SAN, not current SAN.',
      parameters: {
        type: 'object',
        properties: {
          tomeId: { type: 'string', description: 'Tome name/id (e.g. "死灵之书", "伊波恩之书")' },
          mode: { type: 'string', enum: ['browse', 'study', 'consult'], description: 'browse=泛读, study=精读, consult=查资料' },
          languageSkill: { type: 'integer', description: 'Reader\'s language skill value (0-99), used for the browse language check (KP may auto-succeed)' },
          mythosCurrent: { type: 'integer', description: 'Reader\'s current Cthulhu Mythos skill value (0-99)' },
          mythosGain: { type: 'integer', description: 'CMI/CMF mythos gain granted by the tome (browse) or by MR comparison (study)' },
          sanLossExpr: { type: 'string', description: 'SAN loss dice expression for reading (e.g. "1d6")' },
        },
        required: ['tomeId', 'mode', 'mythosCurrent'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'chase_turn',
      description: 'COC 7th 追逐轮: resolves one chase round. Each participant has a position on the location map and action points (1 + MOV above the slowest). Moving 1 location costs 1 AP; hazards/obstacles may be crossed with a skill check (failure = damage + 1D3 AP loss); attacks only against targets in the same location. No push allowed in chases. Returns updated positions and AP.',
      parameters: {
        type: 'object',
        properties: {
          participants: { type: 'array', description: 'Participants: [{name, mov, dex, actionPoints, location}]' },
          map: { type: 'array', description: 'Locations: [{id, hazard?, obstacle?}] where hazard = {skill, damageExpr, difficulty} and obstacle = {durability}' },
          actions: { type: 'array', description: 'Actions this round: [{name, action: "move"|"attack"|"cast"|"other", targetLocation?, skillName?, skillValue?, difficulty?}]' },
          speedChecksDone: { type: 'boolean', description: 'True once the opening CON/drive speed checks (MOV ±1, start 2 locations apart) were made. Omit on the first round.' },
        },
        required: ['participants', 'map', 'actions'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'environment_damage',
      description: 'COC 7th 环境伤害 (Table III): resolves falling/fire/drowning/poison damage. Falling: 1D3 (mud) / 1D6 (grass) / 1D10 (concrete) per 10 feet. Fire: 1D6 (torch) / 1D10 (flamethrower, burning room per round). Drowning: CON check each round, failure takes damage. Poison: 1D10 weak / 2D10 strong / 4D10 lethal; extreme CON success halves, critical success negates.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['fall', 'fire', 'drowning', 'poison'], description: 'Damage kind' },
          severity: { type: 'string', enum: ['mild', 'moderate', 'severe', 'lethal', 'terminal', 'gory'], description: 'Severity (fall/fire: per 10 feet / per round; poison: weak/moderate/severe/lethal map to mild…lethal)' },
          conValue: { type: 'integer', description: 'Investigator CON value for drowning/poison saves' },
          targetIsInvestigator: { type: 'boolean', description: 'True if the investigator is the target (HP applied automatically)' },
        },
        required: ['kind', 'severity', 'targetIsInvestigator'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'development_phase',
      description: 'COC 7th 幕间成长 (interlude/development): for each skill marked for growth, roll 1D100; if the result is greater than the current skill value OR greater than 95, the skill increases by 1D10 (may exceed 100%). Cthulhu Mythos and Credit Rating never grow. Any skill reaching 90%+ grants +2D6 SAN (confidence reward). Then all growth marks are cleared. Also resolves indefinite-insanity recovery if the keeper allows.',
      parameters: {
        type: 'object',
        properties: {
          growthSkills: { type: 'array', description: 'Skills marked for growth: [{name, value}] (value = current skill value 0-99)' },
          cthulhuMythosGain: { type: 'integer', description: 'Optional Cthulhu Mythos gain from tomes/encounters (added directly, no roll)' },
        },
        required: ['growthSkills'],
      },
    },
  },
]

/** Derived tool name list (single source for client-side name validation/display). */
export const COC_TOOL_NAMES: string[] = COC_KP_TOOLS.map((t) => t.function.name)
