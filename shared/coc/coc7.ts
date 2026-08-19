/**
 * COC 7th 规则数据（职业与技能）
 * 参考：Chaosium 7th Edition Investigator Handbook (调查员手册 v1.21)
 */

export interface COCSkillDef {
  id: string
  name: string
  /** 基础百分比（未受训时的默认值） */
  base: number
}

/** 人际技能（职业中「任选其一」） */
export const INTERPERSONAL_SKILL_IDS = ['Charm', 'Fast Talk', 'Intimidate', 'Persuade'] as const

/** COC 7th 标准技能表（含基础值） */
export const COC7_SKILLS: COCSkillDef[] = [
  { id: 'Accounting', name: '会计', base: 5 },
  { id: 'Animal Training', name: '动物驯养', base: 5 },
  { id: 'Anthropology', name: '人类学', base: 1 },
  { id: 'Appraise', name: '估价', base: 5 },
  { id: 'Archaeology', name: '考古学', base: 1 },
  { id: 'Art/Craft', name: '艺术/手艺', base: 5 },
  { id: 'Charm', name: '魅惑', base: 15 },
  { id: 'Climb', name: '攀爬', base: 20 },
  { id: 'Computer Use', name: '计算机', base: 5 },
  { id: 'Credit Rating', name: '信用评级', base: 0 },
  { id: 'Disguise', name: '乔装', base: 5 },
  { id: 'Diving', name: '潜水', base: 1 },
  { id: 'Dodge', name: '闪避', base: 0 },
  { id: 'Drive Auto', name: '驾驶(汽车)', base: 20 },
  { id: 'Electrical Repair', name: '电气维修', base: 10 },
  { id: 'Electronics', name: '电子学', base: 1 },
  { id: 'Fast Talk', name: '话术', base: 5 },
  { id: 'Fighting', name: '斗殴', base: 25 },
  { id: 'Firearms', name: '枪械', base: 20 },
  { id: 'First Aid', name: '急救', base: 30 },
  { id: 'History', name: '历史', base: 5 },
  { id: 'Hypnosis', name: '催眠', base: 1 },
  { id: 'Intimidate', name: '恐吓', base: 15 },
  { id: 'Jump', name: '跳跃', base: 20 },
  { id: 'Language (Other)', name: '其他语言', base: 1 },
  { id: 'Language (Own)', name: '母语', base: 0 },
  { id: 'Law', name: '法律', base: 5 },
  { id: 'Library Use', name: '图书馆使用', base: 20 },
  { id: 'Listen', name: '聆听', base: 20 },
  { id: 'Locksmith', name: '锁匠', base: 1 },
  { id: 'Mechanical Repair', name: '机械维修', base: 10 },
  { id: 'Medicine', name: '医学', base: 1 },
  { id: 'Natural World', name: '博物学', base: 10 },
  { id: 'Navigate', name: '导航', base: 10 },
  { id: 'Occult', name: '神秘学', base: 5 },
  { id: 'Operate Heavy Machinery', name: '操作重型机械', base: 1 },
  { id: 'Persuade', name: '说服', base: 10 },
  { id: 'Pilot', name: '驾驶(船/飞机等)', base: 1 },
  { id: 'Psychoanalysis', name: '精神分析', base: 1 },
  { id: 'Psychology', name: '心理学', base: 10 },
  { id: 'Ride', name: '骑术', base: 5 },
  { id: 'Science', name: '科学', base: 1 },
  { id: 'Sleight of Hand', name: '妙手', base: 10 },
  { id: 'Spot Hidden', name: '侦查', base: 25 },
  { id: 'Stealth', name: '潜行', base: 20 },
  { id: 'Survival', name: '生存', base: 10 },
  { id: 'Swim', name: '游泳', base: 20 },
  { id: 'Throw', name: '投掷', base: 20 },
  { id: 'Track', name: '追踪', base: 10 },
]

const skillNameMap = new Map(COC7_SKILLS.map((s) => [s.id, s.name]))

/** 根据技能 ID 返回中文名称（调查员手册标准） */
export function getSkillName(skillId: string): string {
  return skillNameMap.get(skillId) ?? skillId
}

/* ─────────────── 职业分类 ─────────────── */

export type OccupationCategory =
  | 'academic'
  | 'lawMilitary'
  | 'medical'
  | 'criminal'
  | 'arts'
  | 'business'
  | 'adventure'
  | 'occult'
  | 'technical'
  | 'investigation'
  | 'social'

export const OCCUPATION_CATEGORIES: Record<OccupationCategory, string> = {
  academic: '学术与研究',
  lawMilitary: '执法与军事',
  medical: '医疗',
  criminal: '犯罪',
  arts: '艺术与演艺',
  business: '商业与白领',
  adventure: '冒险与户外',
  occult: '宗教与神秘',
  technical: '工人与技术',
  investigation: '调查与侦探',
  social: '社会与其他',
}

/* ─────────────── 职业定义 ─────────────── */

export interface COCOccupationDef {
  id: string
  name: string
  nameEn: string
  category: OccupationCategory
  /** 信用评级范围 [最低, 最高] */
  creditRange: [number, number]
  /** 适用时代：'any' 通用 | 'classic' 仅1920年代 | 'modern' 仅现代 */
  era: 'any' | 'classic' | 'modern'
  /** 技能模板：技能 id / 'interpersonal' / 'any' */
  skillTemplate: readonly string[]
}

/** COC 7th 全部职业（调查员手册 v1.21） */
export const COC7_OCCUPATIONS: COCOccupationDef[] = [
  // ══════════ 学术与研究 ══════════
  { id: 'archaeologist', name: '考古学家', nameEn: 'Archaeologist', category: 'academic', creditRange: [10, 40], era: 'any', skillTemplate: ['Appraise', 'Archaeology', 'History', 'Language (Other)', 'Library Use', 'Spot Hidden', 'Mechanical Repair', 'any'] },
  { id: 'author', name: '作家', nameEn: 'Author', category: 'academic', creditRange: [9, 30], era: 'any', skillTemplate: ['Art/Craft', 'History', 'Library Use', 'Natural World', 'Language (Other)', 'Language (Own)', 'Psychology', 'any'] },
  { id: 'librarian', name: '图书馆管理员', nameEn: 'Librarian', category: 'academic', creditRange: [9, 35], era: 'any', skillTemplate: ['Accounting', 'Library Use', 'Language (Other)', 'Language (Own)', 'any', 'any', 'any', 'any'] },
  { id: 'professor', name: '教授', nameEn: 'Professor', category: 'academic', creditRange: [20, 70], era: 'any', skillTemplate: ['Library Use', 'Language (Other)', 'Language (Own)', 'Psychology', 'any', 'any', 'any', 'any'] },
  { id: 'researcher', name: '研究员', nameEn: 'Researcher', category: 'academic', creditRange: [9, 30], era: 'any', skillTemplate: ['History', 'Library Use', 'interpersonal', 'Language (Other)', 'Spot Hidden', 'any', 'any', 'any'] },
  { id: 'scientist', name: '科学家', nameEn: 'Scientist', category: 'academic', creditRange: [9, 50], era: 'any', skillTemplate: ['Science', 'Science', 'Science', 'Library Use', 'Language (Other)', 'Language (Own)', 'interpersonal', 'Spot Hidden'] },
  { id: 'student', name: '学生/实习生', nameEn: 'Student/Intern', category: 'academic', creditRange: [5, 10], era: 'any', skillTemplate: ['Language (Own)', 'Library Use', 'Listen', 'any', 'any', 'any', 'any', 'any'] },
  { id: 'laboratory_assistant', name: '实验室助理', nameEn: 'Laboratory Assistant', category: 'academic', creditRange: [10, 30], era: 'any', skillTemplate: ['Library Use', 'Electrical Repair', 'Language (Other)', 'Science', 'Science', 'Spot Hidden', 'any', 'any'] },

  // ══════════ 执法与军事 ══════════
  { id: 'police_detective', name: '警探', nameEn: 'Police Detective', category: 'lawMilitary', creditRange: [20, 50], era: 'any', skillTemplate: ['Disguise', 'Firearms', 'Law', 'Listen', 'interpersonal', 'Psychology', 'Spot Hidden', 'any'] },
  { id: 'police_officer', name: '警官', nameEn: 'Police Officer', category: 'lawMilitary', creditRange: [9, 30], era: 'any', skillTemplate: ['Fighting', 'Firearms', 'First Aid', 'interpersonal', 'Law', 'Psychology', 'Spot Hidden', 'any'] },
  { id: 'federal_agent', name: '联邦探员', nameEn: 'Federal Agent', category: 'lawMilitary', creditRange: [20, 40], era: 'any', skillTemplate: ['Drive Auto', 'Fighting', 'Firearms', 'Law', 'Persuade', 'Stealth', 'Spot Hidden', 'any'] },
  { id: 'soldier', name: '士兵', nameEn: 'Soldier/Marine', category: 'lawMilitary', creditRange: [9, 30], era: 'any', skillTemplate: ['Climb', 'Dodge', 'Fighting', 'Firearms', 'Stealth', 'Survival', 'any', 'any'] },
  { id: 'military_officer', name: '军官', nameEn: 'Military Officer', category: 'lawMilitary', creditRange: [20, 70], era: 'any', skillTemplate: ['Accounting', 'Firearms', 'Navigate', 'First Aid', 'interpersonal', 'interpersonal', 'Psychology', 'any'] },
  { id: 'spy', name: '间谍', nameEn: 'Spy', category: 'lawMilitary', creditRange: [20, 60], era: 'any', skillTemplate: ['Disguise', 'Firearms', 'Listen', 'Language (Other)', 'interpersonal', 'Psychology', 'Sleight of Hand', 'Stealth'] },
  { id: 'bounty_hunter', name: '赏金猎人', nameEn: 'Bounty Hunter', category: 'lawMilitary', creditRange: [9, 30], era: 'any', skillTemplate: ['Drive Auto', 'Electrical Repair', 'Fighting', 'interpersonal', 'Law', 'Psychology', 'Track', 'Stealth'] },
  { id: 'judge', name: '法官', nameEn: 'Judge', category: 'lawMilitary', creditRange: [50, 80], era: 'any', skillTemplate: ['History', 'Intimidate', 'Law', 'Library Use', 'Listen', 'Language (Own)', 'Persuade', 'Psychology'] },

  // ══════════ 医疗 ══════════
  { id: 'doctor', name: '医生', nameEn: 'Doctor of Medicine', category: 'medical', creditRange: [30, 80], era: 'any', skillTemplate: ['First Aid', 'Language (Other)', 'Medicine', 'Psychology', 'Science', 'Science', 'any', 'any'] },
  { id: 'nurse', name: '护士', nameEn: 'Nurse', category: 'medical', creditRange: [9, 30], era: 'any', skillTemplate: ['First Aid', 'Listen', 'Medicine', 'interpersonal', 'Psychology', 'Science', 'Spot Hidden', 'any'] },
  { id: 'psychiatrist', name: '精神病学家', nameEn: 'Psychiatrist', category: 'medical', creditRange: [30, 80], era: 'any', skillTemplate: ['Language (Other)', 'Listen', 'Medicine', 'Persuade', 'Psychoanalysis', 'Psychology', 'Science', 'Science'] },
  { id: 'psychologist', name: '心理学家', nameEn: 'Psychologist', category: 'medical', creditRange: [10, 40], era: 'any', skillTemplate: ['Accounting', 'Library Use', 'Listen', 'Persuade', 'Psychoanalysis', 'Psychology', 'any', 'any'] },
  { id: 'pharmacist', name: '药剂师', nameEn: 'Pharmacist', category: 'medical', creditRange: [35, 75], era: 'any', skillTemplate: ['Accounting', 'First Aid', 'Language (Other)', 'Library Use', 'interpersonal', 'Psychology', 'Science', 'Science'] },
  { id: 'alienist', name: '精神病医生', nameEn: 'Alienist', category: 'medical', creditRange: [10, 60], era: 'classic', skillTemplate: ['Law', 'Listen', 'Medicine', 'Language (Other)', 'Psychoanalysis', 'Psychology', 'Science', 'Science'] },
  { id: 'forensic_surgeon', name: '法医', nameEn: 'Forensic Surgeon', category: 'medical', creditRange: [40, 60], era: 'any', skillTemplate: ['Language (Other)', 'Library Use', 'Medicine', 'Persuade', 'Science', 'Science', 'Spot Hidden', 'any'] },
  { id: 'hospital_orderly', name: '勤杂护工', nameEn: 'Hospital Orderly', category: 'medical', creditRange: [6, 15], era: 'any', skillTemplate: ['Electrical Repair', 'interpersonal', 'Fighting', 'First Aid', 'Listen', 'Mechanical Repair', 'Psychology', 'Stealth'] },
  { id: 'parapsychologist', name: '超心理学家', nameEn: 'Parapsychologist', category: 'medical', creditRange: [9, 30], era: 'any', skillTemplate: ['Anthropology', 'Art/Craft', 'History', 'Library Use', 'Occult', 'Language (Other)', 'Psychology', 'any'] },

  // ══════════ 犯罪 ══════════
  { id: 'criminal_assassin', name: '刺客', nameEn: 'Assassin', category: 'criminal', creditRange: [30, 60], era: 'any', skillTemplate: ['Disguise', 'Electrical Repair', 'Fighting', 'Firearms', 'Locksmith', 'Mechanical Repair', 'Stealth', 'Psychology'] },
  { id: 'criminal_burglar', name: '窃贼', nameEn: 'Burglar', category: 'criminal', creditRange: [5, 40], era: 'any', skillTemplate: ['Appraise', 'Climb', 'Electrical Repair', 'Listen', 'Locksmith', 'Sleight of Hand', 'Stealth', 'Spot Hidden'] },
  { id: 'criminal_conman', name: '欺诈师', nameEn: 'Con Artist', category: 'criminal', creditRange: [10, 65], era: 'any', skillTemplate: ['Appraise', 'Art/Craft', 'Law', 'Listen', 'interpersonal', 'interpersonal', 'Psychology', 'Sleight of Hand'] },
  { id: 'criminal_thug', name: '打手/混混', nameEn: 'Thug', category: 'criminal', creditRange: [5, 30], era: 'any', skillTemplate: ['Drive Auto', 'Fighting', 'Firearms', 'interpersonal', 'interpersonal', 'Psychology', 'Stealth', 'Spot Hidden'] },
  { id: 'criminal_fence', name: '赃物贩子', nameEn: 'Fence', category: 'criminal', creditRange: [20, 40], era: 'any', skillTemplate: ['Accounting', 'Appraise', 'Art/Craft', 'History', 'interpersonal', 'Library Use', 'Spot Hidden', 'any'] },
  { id: 'criminal_forger', name: '赝造者', nameEn: 'Forger', category: 'criminal', creditRange: [20, 60], era: 'any', skillTemplate: ['Accounting', 'Appraise', 'Art/Craft', 'History', 'Library Use', 'Spot Hidden', 'Sleight of Hand', 'any'] },
  { id: 'criminal_smuggler', name: '走私者', nameEn: 'Smuggler', category: 'criminal', creditRange: [20, 60], era: 'any', skillTemplate: ['Firearms', 'Listen', 'Navigate', 'interpersonal', 'Drive Auto', 'Psychology', 'Sleight of Hand', 'Spot Hidden'] },
  { id: 'criminal_street_punk', name: '混混', nameEn: 'Street Punk', category: 'criminal', creditRange: [3, 10], era: 'any', skillTemplate: ['Climb', 'interpersonal', 'Fighting', 'Firearms', 'Jump', 'Sleight of Hand', 'Stealth', 'Throw'] },
  { id: 'criminal_bank_robber', name: '银行劫匪', nameEn: 'Bank Robber', category: 'criminal', creditRange: [5, 75], era: 'any', skillTemplate: ['Drive Auto', 'Electrical Repair', 'Fighting', 'Firearms', 'Intimidate', 'Locksmith', 'Operate Heavy Machinery', 'any'] },
  { id: 'criminal_freelance', name: '独行罪犯', nameEn: 'Freelance Criminal', category: 'criminal', creditRange: [5, 65], era: 'any', skillTemplate: ['Disguise', 'Appraise', 'interpersonal', 'Fighting', 'Locksmith', 'Stealth', 'Psychology', 'Spot Hidden'] },
  { id: 'gangster_boss', name: '黑帮老大', nameEn: 'Gangster Boss', category: 'criminal', creditRange: [60, 95], era: 'any', skillTemplate: ['Fighting', 'Firearms', 'Law', 'Listen', 'interpersonal', 'interpersonal', 'Psychology', 'Spot Hidden'] },
  { id: 'gangster_underling', name: '黑帮马仔', nameEn: 'Gangster Underling', category: 'criminal', creditRange: [9, 20], era: 'any', skillTemplate: ['Drive Auto', 'Fighting', 'Firearms', 'interpersonal', 'interpersonal', 'Psychology', 'any', 'any'] },
  { id: 'gambler', name: '赌徒', nameEn: 'Gambler', category: 'criminal', creditRange: [8, 50], era: 'any', skillTemplate: ['Accounting', 'Art/Craft', 'interpersonal', 'interpersonal', 'Listen', 'Psychology', 'Sleight of Hand', 'Spot Hidden'] },

  // ══════════ 艺术与演艺 ══════════
  { id: 'artist', name: '艺术家', nameEn: 'Artist', category: 'arts', creditRange: [9, 50], era: 'any', skillTemplate: ['Art/Craft', 'History', 'interpersonal', 'Language (Other)', 'Psychology', 'Spot Hidden', 'any', 'any'] },
  { id: 'stage_actor', name: '戏剧演员', nameEn: 'Stage Actor', category: 'arts', creditRange: [9, 40], era: 'any', skillTemplate: ['Art/Craft', 'Disguise', 'Fighting', 'History', 'interpersonal', 'interpersonal', 'Psychology', 'any'] },
  { id: 'film_star', name: '电影演员', nameEn: 'Film Star', category: 'arts', creditRange: [20, 90], era: 'any', skillTemplate: ['Art/Craft', 'Disguise', 'Drive Auto', 'interpersonal', 'interpersonal', 'Psychology', 'any', 'any'] },
  { id: 'musician', name: '音乐家', nameEn: 'Musician', category: 'arts', creditRange: [9, 30], era: 'any', skillTemplate: ['Art/Craft', 'interpersonal', 'Listen', 'Psychology', 'any', 'any', 'any', 'any'] },
  { id: 'entertainer', name: '艺人', nameEn: 'Entertainer', category: 'arts', creditRange: [9, 70], era: 'any', skillTemplate: ['Art/Craft', 'Disguise', 'interpersonal', 'interpersonal', 'Listen', 'Psychology', 'any', 'any'] },
  { id: 'photographer', name: '摄影师', nameEn: 'Photographer', category: 'arts', creditRange: [9, 30], era: 'any', skillTemplate: ['Art/Craft', 'interpersonal', 'Psychology', 'Science', 'Stealth', 'Spot Hidden', 'any', 'any'] },
  { id: 'designer', name: '设计师', nameEn: 'Designer', category: 'arts', creditRange: [20, 60], era: 'any', skillTemplate: ['Accounting', 'Art/Craft', 'Art/Craft', 'Library Use', 'Mechanical Repair', 'Psychology', 'Spot Hidden', 'any'] },
  { id: 'craftsperson', name: '工匠', nameEn: 'Craftsperson', category: 'arts', creditRange: [10, 40], era: 'any', skillTemplate: ['Accounting', 'Art/Craft', 'Art/Craft', 'Mechanical Repair', 'Natural World', 'Spot Hidden', 'any', 'any'] },
  { id: 'stuntman', name: '替身演员', nameEn: 'Stuntman', category: 'arts', creditRange: [10, 50], era: 'any', skillTemplate: ['Climb', 'Dodge', 'Electrical Repair', 'Fighting', 'First Aid', 'Jump', 'Swim', 'any'] },
  { id: 'acrobat', name: '杂技演员', nameEn: 'Acrobat', category: 'arts', creditRange: [9, 20], era: 'any', skillTemplate: ['Climb', 'Dodge', 'Jump', 'Throw', 'Spot Hidden', 'Swim', 'any', 'any'] },

  // ══════════ 商业与白领 ══════════
  { id: 'accountant', name: '会计师', nameEn: 'Accountant', category: 'business', creditRange: [30, 70], era: 'any', skillTemplate: ['Accounting', 'Law', 'Library Use', 'Listen', 'Persuade', 'Psychology', 'Spot Hidden', 'any'] },
  { id: 'lawyer', name: '律师', nameEn: 'Lawyer', category: 'business', creditRange: [30, 80], era: 'any', skillTemplate: ['Accounting', 'Law', 'Library Use', 'interpersonal', 'interpersonal', 'Psychology', 'any', 'any'] },
  { id: 'editor', name: '编辑', nameEn: 'Editor', category: 'business', creditRange: [10, 30], era: 'any', skillTemplate: ['Accounting', 'History', 'Language (Own)', 'interpersonal', 'interpersonal', 'Psychology', 'Spot Hidden', 'any'] },
  { id: 'elected_official', name: '政府官员', nameEn: 'Elected Official', category: 'business', creditRange: [50, 90], era: 'any', skillTemplate: ['Charm', 'History', 'Intimidate', 'Fast Talk', 'Listen', 'Language (Own)', 'Persuade', 'Psychology'] },
  { id: 'secretary', name: '秘书', nameEn: 'Secretary', category: 'business', creditRange: [9, 30], era: 'any', skillTemplate: ['Accounting', 'Art/Craft', 'interpersonal', 'interpersonal', 'Language (Own)', 'Library Use', 'Psychology', 'any'] },
  { id: 'shopkeeper', name: '店老板', nameEn: 'Shopkeeper', category: 'business', creditRange: [20, 40], era: 'any', skillTemplate: ['Accounting', 'interpersonal', 'interpersonal', 'Electrical Repair', 'Listen', 'Mechanical Repair', 'Psychology', 'Spot Hidden'] },
  { id: 'salesperson', name: '推销员', nameEn: 'Salesperson', category: 'business', creditRange: [9, 40], era: 'any', skillTemplate: ['Accounting', 'interpersonal', 'interpersonal', 'Drive Auto', 'Listen', 'Psychology', 'Stealth', 'any'] },
  { id: 'clerk', name: '职员/主管', nameEn: 'Clerk/Executive', category: 'business', creditRange: [9, 20], era: 'any', skillTemplate: ['Accounting', 'Language (Own)', 'Law', 'Library Use', 'Listen', 'interpersonal', 'any', 'any'] },
  { id: 'manager', name: '中高层管理人员', nameEn: 'Manager', category: 'business', creditRange: [20, 80], era: 'any', skillTemplate: ['Accounting', 'Language (Other)', 'Law', 'interpersonal', 'interpersonal', 'Psychology', 'any', 'any'] },
  { id: 'book_dealer', name: '书商', nameEn: 'Book Dealer', category: 'business', creditRange: [20, 40], era: 'any', skillTemplate: ['Accounting', 'Appraise', 'Drive Auto', 'History', 'Library Use', 'Language (Own)', 'Language (Other)', 'interpersonal'] },
  { id: 'antique_dealer', name: '古董商', nameEn: 'Antique Dealer', category: 'business', creditRange: [30, 50], era: 'any', skillTemplate: ['Accounting', 'Appraise', 'Drive Auto', 'interpersonal', 'interpersonal', 'History', 'Library Use', 'Navigate'] },
  { id: 'union_activist', name: '工会活动家', nameEn: 'Union Activist', category: 'business', creditRange: [5, 50], era: 'any', skillTemplate: ['Accounting', 'interpersonal', 'interpersonal', 'Fighting', 'Law', 'Listen', 'Operate Heavy Machinery', 'Psychology'] },

  // ══════════ 冒险与户外 ══════════
  { id: 'big_game_hunter', name: '猎人', nameEn: 'Big Game Hunter', category: 'adventure', creditRange: [20, 50], era: 'any', skillTemplate: ['Firearms', 'Listen', 'Natural World', 'Navigate', 'Language (Other)', 'Science', 'Stealth', 'Track'] },
  { id: 'explorer', name: '探险家', nameEn: 'Explorer', category: 'adventure', creditRange: [55, 80], era: 'classic', skillTemplate: ['Climb', 'Firearms', 'History', 'Jump', 'Natural World', 'Navigate', 'Language (Other)', 'Survival'] },
  { id: 'pilot', name: '飞行员', nameEn: 'Pilot', category: 'adventure', creditRange: [20, 70], era: 'any', skillTemplate: ['Electrical Repair', 'Mechanical Repair', 'Navigate', 'Operate Heavy Machinery', 'Pilot', 'Science', 'any', 'any'] },
  { id: 'aviator', name: '特技飞行员', nameEn: 'Aviator', category: 'adventure', creditRange: [30, 60], era: 'classic', skillTemplate: ['Accounting', 'Electrical Repair', 'Listen', 'Mechanical Repair', 'Navigate', 'Pilot', 'Spot Hidden', 'any'] },
  { id: 'sailor_naval', name: '军舰海员', nameEn: 'Sailor (Naval)', category: 'adventure', creditRange: [9, 30], era: 'any', skillTemplate: ['Electrical Repair', 'Fighting', 'Firearms', 'First Aid', 'Navigate', 'Pilot', 'Survival', 'Swim'] },
  { id: 'sailor_commercial', name: '民用船海员', nameEn: 'Sailor (Commercial)', category: 'adventure', creditRange: [20, 40], era: 'any', skillTemplate: ['First Aid', 'Mechanical Repair', 'Natural World', 'Navigate', 'interpersonal', 'Pilot', 'Spot Hidden', 'Swim'] },
  { id: 'diver', name: '潜水员', nameEn: 'Diver', category: 'adventure', creditRange: [9, 30], era: 'any', skillTemplate: ['Diving', 'First Aid', 'Mechanical Repair', 'Pilot', 'Science', 'Spot Hidden', 'Swim', 'any'] },
  { id: 'mountain_climber', name: '登山家', nameEn: 'Mountain Climber', category: 'adventure', creditRange: [30, 60], era: 'any', skillTemplate: ['Climb', 'First Aid', 'Jump', 'Listen', 'Navigate', 'Language (Other)', 'Survival', 'Track'] },
  { id: 'outdoorsman', name: '旅行家', nameEn: 'Outdoorsman', category: 'adventure', creditRange: [5, 20], era: 'any', skillTemplate: ['Firearms', 'First Aid', 'Listen', 'Natural World', 'Navigate', 'Spot Hidden', 'Survival', 'Track'] },
  { id: 'athlete', name: '运动员', nameEn: 'Athlete', category: 'adventure', creditRange: [9, 70], era: 'any', skillTemplate: ['Climb', 'Jump', 'Fighting', 'Ride', 'interpersonal', 'Swim', 'Throw', 'any'] },
  { id: 'cowboy', name: '牛仔', nameEn: 'Cowboy/Cowgirl', category: 'adventure', creditRange: [9, 20], era: 'any', skillTemplate: ['Dodge', 'Fighting', 'First Aid', 'Jump', 'Ride', 'Survival', 'Throw', 'Track'] },
  { id: 'prospector', name: '淘金客', nameEn: 'Prospector', category: 'adventure', creditRange: [0, 10], era: 'any', skillTemplate: ['Climb', 'First Aid', 'History', 'Mechanical Repair', 'Navigate', 'Science', 'Spot Hidden', 'any'] },

  // ══════════ 宗教与神秘 ══════════
  { id: 'antiquarian', name: '文物学家', nameEn: 'Antiquarian', category: 'occult', creditRange: [30, 70], era: 'any', skillTemplate: ['Appraise', 'Art/Craft', 'History', 'Library Use', 'Language (Other)', 'interpersonal', 'Spot Hidden', 'any'] },
  { id: 'occultist', name: '神秘学家', nameEn: 'Occultist', category: 'occult', creditRange: [9, 65], era: 'any', skillTemplate: ['Anthropology', 'History', 'Library Use', 'interpersonal', 'Occult', 'Language (Other)', 'Science', 'any'] },
  { id: 'clergy', name: '神职人员', nameEn: 'Clergy', category: 'occult', creditRange: [9, 60], era: 'any', skillTemplate: ['Accounting', 'History', 'Library Use', 'Listen', 'Language (Other)', 'interpersonal', 'Psychology', 'any'] },
  { id: 'cult_leader', name: '教团首领', nameEn: 'Cult Leader', category: 'occult', creditRange: [30, 60], era: 'any', skillTemplate: ['Accounting', 'interpersonal', 'interpersonal', 'Occult', 'Psychology', 'Spot Hidden', 'any', 'any'] },
  { id: 'missionary', name: '传教士', nameEn: 'Missionary', category: 'occult', creditRange: [0, 30], era: 'any', skillTemplate: ['Art/Craft', 'First Aid', 'Mechanical Repair', 'Medicine', 'Natural World', 'interpersonal', 'any', 'any'] },
  { id: 'zealot', name: '狂热者', nameEn: 'Zealot', category: 'occult', creditRange: [0, 30], era: 'any', skillTemplate: ['History', 'interpersonal', 'interpersonal', 'Psychology', 'Stealth', 'any', 'any', 'any'] },
  { id: 'deprogrammer', name: '除魅师', nameEn: 'Deprogrammer', category: 'occult', creditRange: [20, 50], era: 'modern', skillTemplate: ['interpersonal', 'interpersonal', 'Drive Auto', 'Fighting', 'History', 'Occult', 'Psychology', 'Stealth'] },

  // ══════════ 工人与技术 ══════════
  { id: 'engineer', name: '工程师', nameEn: 'Engineer', category: 'technical', creditRange: [30, 60], era: 'any', skillTemplate: ['Art/Craft', 'Electrical Repair', 'Library Use', 'Mechanical Repair', 'Operate Heavy Machinery', 'Science', 'Science', 'any'] },
  { id: 'mechanic', name: '技师', nameEn: 'Mechanic', category: 'technical', creditRange: [9, 40], era: 'any', skillTemplate: ['Art/Craft', 'Climb', 'Drive Auto', 'Electrical Repair', 'Mechanical Repair', 'Operate Heavy Machinery', 'any', 'any'] },
  { id: 'architect', name: '建筑师', nameEn: 'Architect', category: 'technical', creditRange: [30, 70], era: 'any', skillTemplate: ['Accounting', 'Art/Craft', 'Law', 'Language (Own)', 'Library Use', 'Persuade', 'Psychology', 'Science'] },
  { id: 'farmer', name: '农民', nameEn: 'Farmer', category: 'technical', creditRange: [9, 30], era: 'any', skillTemplate: ['Art/Craft', 'Drive Auto', 'interpersonal', 'Mechanical Repair', 'Natural World', 'Operate Heavy Machinery', 'Track', 'any'] },
  { id: 'firefighter', name: '消防员', nameEn: 'Firefighter', category: 'technical', creditRange: [9, 30], era: 'any', skillTemplate: ['Climb', 'Dodge', 'Drive Auto', 'First Aid', 'Jump', 'Mechanical Repair', 'Operate Heavy Machinery', 'Throw'] },
  { id: 'laborer', name: '工人', nameEn: 'Laborer', category: 'technical', creditRange: [9, 30], era: 'any', skillTemplate: ['Drive Auto', 'Electrical Repair', 'Fighting', 'First Aid', 'Mechanical Repair', 'Operate Heavy Machinery', 'Throw', 'any'] },
  { id: 'lumberjack', name: '伐木工', nameEn: 'Lumberjack', category: 'technical', creditRange: [9, 30], era: 'any', skillTemplate: ['Climb', 'Dodge', 'Fighting', 'First Aid', 'Jump', 'Mechanical Repair', 'Natural World', 'Throw'] },
  { id: 'miner', name: '矿工', nameEn: 'Miner', category: 'technical', creditRange: [9, 30], era: 'any', skillTemplate: ['Climb', 'Science', 'Jump', 'Mechanical Repair', 'Operate Heavy Machinery', 'Stealth', 'Spot Hidden', 'any'] },
  { id: 'driver', name: '司机', nameEn: 'Driver', category: 'technical', creditRange: [9, 20], era: 'any', skillTemplate: ['Accounting', 'Drive Auto', 'Listen', 'interpersonal', 'Mechanical Repair', 'Navigate', 'Psychology', 'any'] },
  { id: 'chauffeur', name: '私人司机', nameEn: 'Chauffeur', category: 'technical', creditRange: [10, 40], era: 'any', skillTemplate: ['Drive Auto', 'interpersonal', 'interpersonal', 'Listen', 'Mechanical Repair', 'Navigate', 'Spot Hidden', 'any'] },
  { id: 'taxi_driver', name: '出租车司机', nameEn: 'Taxi Driver', category: 'technical', creditRange: [9, 30], era: 'any', skillTemplate: ['Accounting', 'Drive Auto', 'Electrical Repair', 'Fast Talk', 'Mechanical Repair', 'Navigate', 'Spot Hidden', 'any'] },
  { id: 'computer_programmer', name: '计算机程序员', nameEn: 'Computer Programmer', category: 'technical', creditRange: [10, 70], era: 'modern', skillTemplate: ['Computer Use', 'Electrical Repair', 'Electronics', 'Library Use', 'Science', 'Spot Hidden', 'any', 'any'] },
  { id: 'hacker', name: '黑客', nameEn: 'Hacker', category: 'technical', creditRange: [10, 70], era: 'modern', skillTemplate: ['Computer Use', 'Electrical Repair', 'Electronics', 'Library Use', 'Spot Hidden', 'interpersonal', 'any', 'any'] },

  // ══════════ 调查与侦探 ══════════
  { id: 'private_investigator', name: '私家侦探', nameEn: 'Private Investigator', category: 'investigation', creditRange: [9, 30], era: 'any', skillTemplate: ['Art/Craft', 'Disguise', 'Law', 'Library Use', 'interpersonal', 'Psychology', 'Spot Hidden', 'any'] },
  { id: 'agency_detective', name: '事务所侦探', nameEn: 'Agency Detective', category: 'investigation', creditRange: [20, 45], era: 'any', skillTemplate: ['interpersonal', 'Fighting', 'Firearms', 'Law', 'Library Use', 'Psychology', 'Stealth', 'Track'] },
  { id: 'journalist_investigative', name: '调查记者', nameEn: 'Investigative Journalist', category: 'investigation', creditRange: [9, 30], era: 'any', skillTemplate: ['Art/Craft', 'interpersonal', 'History', 'Library Use', 'Language (Own)', 'Psychology', 'any', 'any'] },
  { id: 'journalist_reporter', name: '通讯记者', nameEn: 'Reporter', category: 'investigation', creditRange: [9, 30], era: 'any', skillTemplate: ['Art/Craft', 'History', 'Listen', 'Language (Own)', 'interpersonal', 'Psychology', 'Stealth', 'Spot Hidden'] },
  { id: 'foreign_correspondent', name: '驻外记者', nameEn: 'Foreign Correspondent', category: 'investigation', creditRange: [10, 40], era: 'any', skillTemplate: ['History', 'Language (Other)', 'Language (Own)', 'Listen', 'interpersonal', 'interpersonal', 'Psychology', 'any'] },
  { id: 'museum_curator', name: '博物馆管理员', nameEn: 'Museum Curator', category: 'investigation', creditRange: [10, 30], era: 'any', skillTemplate: ['Accounting', 'Appraise', 'Archaeology', 'History', 'Library Use', 'Occult', 'Language (Other)', 'Spot Hidden'] },

  // ══════════ 社会与其他 ══════════
  { id: 'dilettante', name: '业余艺术爱好者', nameEn: 'Dilettante', category: 'social', creditRange: [50, 99], era: 'any', skillTemplate: ['Art/Craft', 'Firearms', 'Language (Other)', 'Ride', 'interpersonal', 'any', 'any', 'any'] },
  { id: 'gentleman', name: '绅士/淑女', nameEn: 'Gentleman/Lady', category: 'social', creditRange: [40, 90], era: 'any', skillTemplate: ['Art/Craft', 'interpersonal', 'interpersonal', 'Firearms', 'History', 'Language (Other)', 'Navigate', 'Ride'] },
  { id: 'bartender', name: '酒保', nameEn: 'Bartender', category: 'social', creditRange: [8, 25], era: 'any', skillTemplate: ['Accounting', 'interpersonal', 'interpersonal', 'Fighting', 'Listen', 'Psychology', 'Spot Hidden', 'any'] },
  { id: 'butler', name: '管家/男仆/女仆', nameEn: 'Butler/Valet/Maid', category: 'social', creditRange: [9, 40], era: 'any', skillTemplate: ['Accounting', 'Art/Craft', 'First Aid', 'Listen', 'Psychology', 'Spot Hidden', 'any', 'any'] },
  { id: 'waiter', name: '服务生', nameEn: 'Waiter/Waitress', category: 'social', creditRange: [9, 20], era: 'any', skillTemplate: ['Accounting', 'Art/Craft', 'Dodge', 'Listen', 'interpersonal', 'interpersonal', 'Psychology', 'any'] },
  { id: 'drifter', name: '流浪者', nameEn: 'Drifter', category: 'social', creditRange: [0, 5], era: 'any', skillTemplate: ['Climb', 'Jump', 'Listen', 'Navigate', 'interpersonal', 'Stealth', 'any', 'any'] },
  { id: 'hobo', name: '游民', nameEn: 'Hobo', category: 'social', creditRange: [0, 5], era: 'any', skillTemplate: ['Art/Craft', 'Climb', 'Jump', 'Listen', 'Locksmith', 'Navigate', 'Stealth', 'any'] },
  { id: 'prostitute', name: '性工作者', nameEn: 'Prostitute', category: 'social', creditRange: [5, 50], era: 'any', skillTemplate: ['Art/Craft', 'interpersonal', 'interpersonal', 'Dodge', 'Psychology', 'Sleight of Hand', 'Stealth', 'any'] },
  { id: 'tribe_member', name: '部落成员', nameEn: 'Tribe Member', category: 'social', creditRange: [0, 15], era: 'any', skillTemplate: ['Climb', 'Fighting', 'Listen', 'Natural World', 'Occult', 'Spot Hidden', 'Swim', 'Survival'] },
  { id: 'animal_trainer', name: '动物训练师', nameEn: 'Animal Trainer', category: 'social', creditRange: [10, 40], era: 'any', skillTemplate: ['Jump', 'Listen', 'Natural World', 'Animal Training', 'Science', 'Stealth', 'Track', 'any'] },
  { id: 'asylum_attendant', name: '精神病院看护', nameEn: 'Asylum Attendant', category: 'social', creditRange: [8, 20], era: 'any', skillTemplate: ['Dodge', 'Fighting', 'First Aid', 'interpersonal', 'interpersonal', 'Listen', 'Psychology', 'Stealth'] },
  { id: 'undertaker', name: '殡葬师', nameEn: 'Undertaker', category: 'social', creditRange: [20, 40], era: 'any', skillTemplate: ['Accounting', 'Drive Auto', 'interpersonal', 'History', 'Occult', 'Psychology', 'Science', 'Science'] },
  { id: 'zookeeper', name: '饲养员', nameEn: 'Zookeeper', category: 'social', creditRange: [9, 40], era: 'any', skillTemplate: ['Animal Training', 'Accounting', 'Dodge', 'First Aid', 'Natural World', 'Medicine', 'Science', 'Science'] },
]

/** 属性投掷：STR/CON/DEX/APP/POW/Luck 用 3d6×5；SIZ/INT/EDU 用 (2d6+6)×5（规则书标准） */
export const COC7_ATTRIBUTE_IDS = ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu', 'luck'] as const
export type COCAttributeId = (typeof COC7_ATTRIBUTE_IDS)[number]

/** 投一颗 d6 */
export function rollD6(): number {
  return Math.floor(Math.random() * 6) + 1
}

/** 投 3d6 */
export function roll3d6(): number {
  return rollD6() + rollD6() + rollD6()
}

/** 投 2d6 */
export function roll2d6(): number {
  return rollD6() + rollD6()
}

/** 3d6×5，范围 15–90（STR/CON/DEX/APP/POW/Luck） */
export function rollAttribute3d6(): number {
  return roll3d6() * 5
}

/** (2d6+6)×5，范围 40–90（SIZ/INT/EDU） */
export function rollAttribute2d6p6(): number {
  return (roll2d6() + 6) * 5
}

/** 生成全部 9 项属性（规则书标准） */
export function rollAllAttributes(): Record<COCAttributeId, number> {
  return {
    str: rollAttribute3d6(),
    con: rollAttribute3d6(),
    siz: rollAttribute2d6p6(),
    dex: rollAttribute3d6(),
    app: rollAttribute3d6(),
    int: rollAttribute2d6p6(),
    pow: rollAttribute3d6(),
    edu: rollAttribute2d6p6(),
    luck: rollAttribute3d6(),
  }
}
