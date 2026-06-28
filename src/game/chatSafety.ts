// SAFETY-CRITICAL chat filter for a kids' game.
//
// THE #1 REQUIREMENT: a child must NOT be able to share personal/contact info or
// use profanity through chat, EVEN WHEN ACTIVELY TRYING TO EVADE THE FILTER.
//
// Threat model: the adversary is a curious, motivated child (and the predators who
// coach them). They will deliberately obfuscate — space out digits ("5 5 5 1..."),
// spell numbers out ("five five five"), swap letters for lookalikes ("ph0ne",
// "sn@p", "𝓹𝓱𝓸𝓷𝓮"), insert dots/dashes ("g.m.a.i.l . c0m"), pad with repeats
// ("heeeyyy add meee"), or mix all of the above. A leaked phone number, address,
// or third-party handle is a child-safety incident; a blocked-but-innocent message
// is a minor annoyance. THEREFORE: false positives are acceptable, false negatives
// are not. We DEFAULT-DENY on any ambiguity in the contact category.
//
// Strategy:
//   1. NORMALIZE the input down to a canonical, evasion-resistant ascii form
//      (see normalizeForMatch). All detectors run against THIS form, so the same
//      detector catches "phone", "p h o n e", "ph0ne" and "𝓹𝓱𝓸𝓷𝓮" with one rule.
//   2. Run detectors in PRIORITY ORDER (contact first — it's the most dangerous).
//   3. Return the ORIGINAL trimmed text when allowed, so normal punctuation and
//      casing survive for display. The normalized form is ONLY for matching.
//
// No external deps. Strict-TS clean. The keyword/profanity sets are kept as plain
// arrays at the top so a non-engineer can audit and extend them.

import type { FilterVerdict } from './kidShared'
import { CHAT_MAX_LEN } from './kidShared'

// ---------------------------------------------------------------------------
// AUDITABLE WORD SETS
// Keep these as flat, separated arrays. Each entry is matched against the
// NORMALIZED text, so you do NOT need to add leet/spacing variants by hand —
// normalizeForMatch already folds "ph0ne" -> "phone", "f u c k" -> "fuck", etc.
// Add the plain lowercase ascii form of any new term and the normalizer handles
// the evasion surface.
// ---------------------------------------------------------------------------

/** CONTACT KEYWORDS — phrases that signal a child is sharing or soliciting
 *  identity / contact / meetup info. These are intentionally broad: in this
 *  category we would rather over-block than let a single real handle through. */
const CONTACT_KEYWORDS: readonly string[] = [
  // --- direct contact-info nouns ---
  'phone',
  'phonenumber',
  'mobilenumber',
  'cellnumber',
  'mynumber',
  'mynumberis',
  'numba', // slang "number"
  'urdigits', // "your/ur digits" -> phone solicitation
  'yourdigits',
  'urnumber',
  'yournumber',
  'callme',
  'textme',
  'txtme', // "txt me" slang
  'hmu', // "hit me up"
  'hitmeup',
  'phoneme',
  'ringme',
  'whatsapp',
  'imessage',
  'facetime',
  // --- email ---
  'email',
  'emailme',
  'myemail',
  'gmail',
  'hotmail',
  'outlook',
  'yahoo',
  'icloud',
  'protonmail',
  // --- meet / find / add me (grooming-adjacent solicitation) ---
  // NOTE: the "meet me" / "meet up" family is NOT listed here anymore — it lives
  // in MEETUP_KEYWORDS below and is checked through a narrow carve-out
  // (isSafeInGameMeetup) so that legitimate in-game coordination
  // ("meet me at the arcade portal") passes while real-world / off-platform
  // meetup attempts ("meet me at the mall tonight") still BLOCK. See the meetup
  // section near the detectors.
  // "find me" / "follow me" alone are normal in-game ("come find me!",
  // "follow me to the arcade"), so we block only the "...on <platform>" solicit
  // form plus the platform tokens below. "add me" stays — there is no benign
  // in-game reason to say it, and it's a top grooming opener.
  'findmeon',
  'addme',
  'addmeon',
  'followmeon',
  'dmme',
  'messageme',
  'inboxme',
  'comeover',
  'cometomyhouse',
  'wheredoyoulive',
  'wheredoulive', // "where do U live" (u = you)
  'wheredoyalive',
  'whatsyouraddress',
  'whatsuraddress',
  'uraddy', // slang "your address"
  'youraddy',
  'sendpic',
  'sendpics',
  'sendmeapic', // "send me a pic"
  'sendmeapicture',
  'sendaphoto',
  'sendmeaphoto',
  'sendyourpic',
  'sendapic',
  'wannaseeapic',
  'webcam',
  'videochat',
  'videocall',
  // --- identity sharing ---
  'mynameis',
  'mynamesis',
  'realname',
  'myrealname',
  'imreallycalled',
  // NOTE: bare "iam"/"imreally" were intentionally REMOVED. They fire on the
  // ubiquitous gameplay phrase "I am ..." ("i am at the moon base", "i am
  // winning"), so they blocked far more innocent chat than they protected.
  // Real name-sharing is covered by the explicit "my name is" family above;
  // a child can't share a *contact* identity with just "I am" + a word.
  'mylastname',
  'iliveat',
  'ilivein',
  'ilivenear',
  'iliveon',
  'myaddress',
  'myhomeaddress',
  'myhouse',
  'mystreet',
  'myzipcode',
  'mypostcode',
  'myschool',
  'myage',
  'imyearsold',
  'howoldareyou',
  // --- third-party platforms / handles that are DISTINCTIVE enough to match as
  //     raw substrings (they don't appear inside common English words) ---
  'snapchat',
  'mysnap',
  'snapme', // "snap me <handle>" — handle solicitation (distinct from "oh snap")
  'admeon', // "add me on <platform>" surviving double-letter collapse ("addddd me on")
  'instagram',
  'myinsta',
  'tiktok',
  'mytiktok',
  'discord',
  'mydiscord',
  'discordtag',
  'roblox',
  'myroblox',
  'fortnite',
  'gamertag',
  'twitch',
  'youtube',
  'mychannel',
  'telegram',
  'wechat',
  'whatsapp',
  'twitter',
  'facebook',
  'venmo',
  'cashapp',
  'paypal',
]

/** GROOMING / PREDATOR phrases — curated, highest-priority blocklist. Matched as
 *  substrings against the NORMALIZED (separator-stripped, de-leet) view, so spacing
 *  / leet / unicode evasion is already folded. Each entry is the joined-ascii form
 *  of a realistic predator opener. These are real-world-coercion phrases with no
 *  benign in-game reading, so blocking them costs nothing in normal play. */
const GROOMING_PHRASES: readonly string[] = [
  'donttellyourparents',
  'donttellyourmom',
  'donttellyourdad',
  'donttellanyone',
  'keepitsecret',
  'ourlittlesecret',
  'areyourparentshome',
  'areyourparentsthere',
  'whereareyourparents',
  'isanyonewatching',
  'areyoualone',
  'homealone',
  'icancomepickyou', // "i can come pick you up"
  'comepickyouup',
  'illpickyouup',
  'pickyouup',
  'sendaselfie',
  'sendselfie',
  'sendapic',
  'turnonyourcamera',
  'turnonyourcam',
  'turnoncamera',
  'onyourcamera',
  'letstalksomewhereelse',
  'talksomewhereelse',
  'somewhereelsenothere',
  'notherelets', // "...not here, lets..."
  'meetirl',
  'meetinreallife',
  'videochat',
  'videocall',
  'whatdoyoulooklike',
]

/** IDENTITY / SCHOOL / AGE keywords — personal-info disclosure, matched against the
 *  NORMALIZED view. Real-world identity a child should not share. */
const IDENTITY_KEYWORDS: readonly string[] = [
  'whatschool',
  'gotoschool', // "where do you go to school"
  'mybday',
  'mybirthday',
  'birthdayis',
  'housenumber',
  'realnameis',
  'irlimcalled',
  'imcalled', // "irl im called <name>"
  'middleschool',
  'highschool',
  'elementaryschool',
]

/** Platform/handle names that ARE common English substrings ("snap" in
 *  "snapshot", "insta" in "instant", "steam" in "lets team", "kik", "psn",
 *  "xbox"). Matching these as raw substrings caused false positives on normal
 *  chat, so they are matched against WHOLE WORD TOKENS instead (see
 *  mentionsContactPlatform). A child sharing "add me on snap" still trips the
 *  "addme"/"followmeon" keyword OR the standalone token "snap". */
const CONTACT_PLATFORM_TOKENS: readonly string[] = [
  // Not common English words, so safe to block even as a bare token.
  'steam',
  'kik',
  'psn',
  'xbox',
  'fortnite',
  'roblox',
  'discord',
  'tiktok',
  'snapchat',
  'instagram',
  // NOTE: bare "snap" and "insta" are intentionally EXCLUDED — "oh snap" and
  // "instant" are normal kid chat. Sharing those handles still trips "mysnap" /
  // "myinsta" / "addme" / "findmeon" in the keyword set above.
]

/** PROFANITY / SLURS / SEXUAL CONTENT — matched against the NORMALIZED text.
 *  Curated and intentionally compact; the normalizer neutralizes the usual
 *  leet/spacing/unicode evasion so we list the plain ascii root only.
 *  Stored without vowels-as-symbols etc. on purpose — see note above. */
const PROFANITY: readonly string[] = [
  // general profanity
  'fuck',
  'fuk',
  'fuc', // common truncation that de-leet/collapse lands on
  'shit',
  'bullshit',
  'bitch',
  'bastard',
  'asshole',
  'dumbass',
  'jackass',
  'damnit',
  'goddamn',
  'crap', // mild; included so we can tune kids-strictness in one place
  'piss',
  'dick',
  'cock',
  'prick',
  'pussy',
  'cunt',
  'twat',
  'wanker',
  'douche',
  'slut',
  'whore',
  'hoe',
  'skank',
  // sexual content
  'sex',
  'sexy',
  'porn',
  'pornhub',
  // NOTE: "pron" (the "pr0n" evasion) is intentionally NOT listed — as a bare
  // substring it collides with "prone", "pronoun", "pronto". The standard leet
  // form "p0rn" still de-leets to "porn" and is caught above.
  'nude',
  'nudes',
  'naked',
  'boobs',
  'tits',
  'titties',
  'penis',
  'vagina',
  'horny',
  'cum',
  'jizz',
  'blowjob',
  'handjob',
  'rape',
  'molest',
  'pedo',
  'pedophile',
  // slurs (kept minimal but blocked hard)
  'nigger',
  'nigga',
  'faggot',
  'fag',
  'retard',
  'retarded',
  'spic',
  'chink',
  'kike',
  'tranny',
]

// ---------------------------------------------------------------------------
// NORMALIZATION
// ---------------------------------------------------------------------------

/** Number-words (and a few homophones) used to spell out digits. A run of 3+ of
 *  these in a row is treated as a number share (e.g. "five five five one two"). */
const NUMBER_WORDS: readonly string[] = [
  'zero',
  'oh', // spoken "oh" for 0
  'one',
  'two',
  'to', // homophone padding
  'too',
  'three',
  'four',
  'for', // homophone padding
  'five',
  'six',
  'seven',
  'eight',
  'ate', // homophone padding
  'nine',
]

/** The DIGIT number-words (no homophone padding) used to detect a concatenated
 *  spelled-out run ("fivefivefive onetwothree"). Ordered longest-first so the
 *  greedy chunker prefers "three"/"seven"/"eight" over a shorter prefix. Only the
 *  unambiguous digit words live here — homophones like "to"/"for"/"ate" are NOT
 *  greedily chunked because they collide with ordinary English ("i want to win",
 *  "go for it"). */
const DIGIT_WORDS: readonly string[] = [
  'zero',
  'three',
  'seven',
  'eight',
  'four',
  'five',
  'nine',
  'one',
  'two',
  'six',
  'oh',
]

/** US state names + common abbreviations, plus a handful of well-known US cities,
 *  used by the LOCATION detector. Real-world geography a child should not disclose.
 *  Kept as an auditable flat list. Multi-word names are stored space-joined to be
 *  matched against the separator-stripped form is NOT done here; instead we match
 *  against word-boundary text (see looksLikeLocation). */
const US_STATES: readonly string[] = [
  'alabama',
  'alaska',
  'arizona',
  'arkansas',
  'california',
  'colorado',
  'connecticut',
  'delaware',
  'florida',
  'georgia',
  'hawaii',
  'idaho',
  'illinois',
  'indiana',
  'iowa',
  'kansas',
  'kentucky',
  'louisiana',
  'maine',
  'maryland',
  'massachusetts',
  'michigan',
  'minnesota',
  'mississippi',
  'missouri',
  'montana',
  'nebraska',
  'nevada',
  'ohio',
  'oklahoma',
  'oregon',
  'pennsylvania',
  'tennessee',
  'texas',
  'utah',
  'vermont',
  'virginia',
  'washington',
  'wisconsin',
  'wyoming',
]

/** Well-known real-world city names that a child might disclose. We keep this list
 *  curated and distinctive (names that don't collide with in-game vocabulary). */
const REAL_CITIES: readonly string[] = [
  'chicago',
  'houston',
  'phoenix',
  'philadelphia',
  'dallas',
  'austin',
  'seattle',
  'denver',
  'boston',
  'atlanta',
  'miami',
  'detroit',
  'portland',
  'springfield',
  'london',
  'manchester',
  'toronto',
  'sydney',
  'melbourne',
  'losangeles',
]

/** Homoglyph / fancy-unicode -> ascii. Covers the common attack surface a kid can
 *  reach from a phone keyboard / "fancy text" generators: fullwidth Latin,
 *  mathematical bold/script/double-struck/sans/monospace blocks, and a handful of
 *  Cyrillic/Greek lookalikes. We map to the BASE ascii letter; casing is dropped
 *  later by toLowerCase. */
function mapHomoglyph(cp: number): string | null {
  // Fullwidth ASCII (U+FF01..U+FF5E) -> ASCII (U+0021..U+007E)
  if (cp >= 0xff01 && cp <= 0xff5e) return String.fromCharCode(cp - 0xfee0)

  // Mathematical Alphanumeric Symbols — letters. Each contiguous 26-codepoint
  // block maps a..z (and a separate one for A..Z). We fold to lowercase ascii.
  const mathRanges: ReadonlyArray<readonly [number, number, number]> = [
    // [start, end, asciiBase] where asciiBase is 'a'(97) or 'A'(65)
    [0x1d400, 0x1d419, 65], // bold A-Z
    [0x1d41a, 0x1d433, 97], // bold a-z
    [0x1d434, 0x1d44d, 65], // italic A-Z
    [0x1d44e, 0x1d467, 97], // italic a-z
    [0x1d468, 0x1d481, 65], // bold italic A-Z
    [0x1d482, 0x1d49b, 97], // bold italic a-z
    [0x1d49c, 0x1d4b5, 65], // script A-Z
    [0x1d4b6, 0x1d4cf, 97], // script a-z
    [0x1d4d0, 0x1d4e9, 65], // bold script A-Z
    [0x1d4ea, 0x1d503, 97], // bold script a-z
    [0x1d504, 0x1d51d, 65], // fraktur A-Z
    [0x1d51e, 0x1d537, 97], // fraktur a-z
    [0x1d538, 0x1d551, 65], // double-struck A-Z
    [0x1d552, 0x1d56b, 97], // double-struck a-z
    [0x1d56c, 0x1d585, 65], // bold fraktur A-Z
    [0x1d586, 0x1d59f, 97], // bold fraktur a-z
    [0x1d5a0, 0x1d5b9, 65], // sans A-Z
    [0x1d5ba, 0x1d5d3, 97], // sans a-z
    [0x1d5d4, 0x1d5ed, 65], // sans bold A-Z
    [0x1d5ee, 0x1d607, 97], // sans bold a-z
    [0x1d608, 0x1d621, 65], // sans italic A-Z
    [0x1d622, 0x1d63b, 97], // sans italic a-z
    [0x1d63c, 0x1d655, 65], // sans bold italic A-Z
    [0x1d656, 0x1d66f, 97], // sans bold italic a-z
    [0x1d670, 0x1d689, 65], // monospace A-Z
    [0x1d68a, 0x1d6a3, 97], // monospace a-z
  ]
  for (const [start, end, base] of mathRanges) {
    if (cp >= start && cp <= end) return String.fromCharCode(base + (cp - start))
  }

  // Common single-character lookalikes (Cyrillic/Greek/symbols -> ascii).
  const single: Record<number, string> = {
    0x0430: 'a', // Cyrillic а
    0x0435: 'e', // Cyrillic е
    0x043e: 'o', // Cyrillic о
    0x0440: 'p', // Cyrillic р
    0x0441: 'c', // Cyrillic с
    0x0445: 'x', // Cyrillic х
    0x0443: 'y', // Cyrillic у
    0x03b1: 'a', // Greek alpha
    0x03bf: 'o', // Greek omicron
    0x03c1: 'p', // Greek rho
    0x0455: 's', // Cyrillic ѕ
    0x0456: 'i', // Cyrillic і
    0x0458: 'j', // Cyrillic ј
  }
  return single[cp] ?? null
}

/** Leet / symbol substitutions applied AFTER diacritic + homoglyph folding.
 *  Mapped per the spec: 4->a, 3->e, 1/!->i, 0->o, 5->s, 7->t, @->a.
 *  We also fold a couple of obvious extras ($->s, |->i) since they ride the same
 *  evasion path; this only ever makes matching MORE aggressive, never less. */
const LEET: Record<string, string> = {
  '4': 'a',
  '@': 'a',
  '3': 'e',
  '1': 'i',
  '!': 'i',
  '|': 'i',
  '0': 'o',
  '5': 's',
  $: 's',
  '7': 't',
}

/** Separator characters used to break up tokens ("p h o n e", "g.m.a.i.l").
 *  Stripped so spaced/punctuated evasion collapses back into a single token.
 *  NOTE: removing spaces means our keyword list uses the joined form
 *  ("callme", "mynameis"). */
const SEPARATORS = /[ \t\r\n._\-+*~^=/\\|·•,'"`()[\]{}<>:;]/g

/**
 * Collapse evasion to a canonical match form. Order matters:
 *   1. Unicode NFKD + strip combining marks  -> remove diacritics, decompose
 *      fancy compatibility chars where possible.
 *   2. Per-codepoint homoglyph/fullwidth map -> fold fancy alphabets to ascii.
 *   3. Lowercase.
 *   4. De-leet (digits/symbols -> letters).
 *   5. Strip separators (spaces, dots, dashes, underscores, punctuation).
 *   6. Collapse 3+ repeated chars to a single char (heeeello -> helo? no:) — we
 *      collapse runs to a SINGLE char so "heeeello" -> "helo" would lose a letter;
 *      instead we collapse to at most TWO so real double letters survive while
 *      "fuuuuck"/"fuuck" still lands on the 'fuck'/'fuk' roots via a second pass.
 *
 * The function is exported so the detectors (and tests) share ONE definition of
 * "the same string". "p h o n e", "ph0ne", "𝓹𝓱𝓸𝓷𝓮" all normalize to "phone".
 */
export function normalizeForMatch(text: string): string {
  // 0. Strip zero-width / invisible chars (ZWSP, ZWNJ, ZWJ, word-joiner, BOM,
  //    soft hyphen) that a kid inserts INSIDE a trigger word ("sn<zwsp>ap").
  // eslint-disable-next-line no-misleading-character-class
  let s = text.replace(/[​-‍⁠﻿­]/g, '')
  // 1. Decompose + strip diacritics (café -> cafe, ñ -> n).
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '')

  // 2. Homoglyph / fullwidth / fancy-alphabet folding, codepoint by codepoint.
  let folded = ''
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    if (cp === undefined) continue
    const mapped = mapHomoglyph(cp)
    folded += mapped ?? ch
  }
  s = folded

  // 3. Lowercase.
  s = s.toLowerCase()

  // 4. De-leet. Done char-by-char so every leet glyph is folded before we strip
  //    separators (so "@" -> "a" survives, while "." gets removed in step 5).
  let deleet = ''
  for (const ch of s) deleet += LEET[ch] ?? ch
  s = deleet

  // 5. Strip separators used to fragment tokens.
  s = s.replace(SEPARATORS, '')

  // 6. Collapse long repeat runs. Two passes of "3+ -> 1" so "heeeello" -> "helo"
  //    is avoided: we instead reduce any run of length >= 3 down to ONE, then we
  //    keep a second comparison form. To keep real doubles ("hello", "tomorrow")
  //    intact while still defeating "fuuuuck", we collapse runs of length >= 3 to
  //    a single character. Real English doubles are length 2 and untouched.
  s = s.replace(/(.)\1{2,}/g, '$1')

  return s
}

/** Secondary fully-collapsed form: EVERY repeat run -> single char. Used ONLY by
 *  the profanity/contact substring scans as a backstop, so "heeello" (-> "helo"
 *  in the primary form, which is fine) and intentional double-letter padding like
 *  "fuuck"/"ffuucckk" both reduce to the bare root. This can over-collapse real
 *  words (e.g. "moon" -> "mon") which is acceptable for substring blocking but NOT
 *  used for display. */
function collapseAll(s: string): string {
  return s.replace(/(.)\1+/g, '$1')
}

// ---------------------------------------------------------------------------
// DIGIT FOLDING (the root-cause fix for separated / disguised phone numbers)
// ---------------------------------------------------------------------------

/** Map a single codepoint to its ascii digit (0-9) if it IS a digit in some
 *  unicode script, else null. Covers ascii, fullwidth (U+FF10..U+FF19), circled
 *  (①..⑨ and ⓪), parenthesized, fullwidth, and mathematical digit blocks. The
 *  keycap-emoji digits ("5️⃣") are sequences (ascii digit + VS16 + U+20E3) and so
 *  are handled by the ascii branch automatically once we strip the combiners. */
function unicodeDigit(cp: number): string | null {
  if (cp >= 0x30 && cp <= 0x39) return String.fromCharCode(cp) // ascii 0-9
  if (cp >= 0xff10 && cp <= 0xff19) return String.fromCharCode(cp - 0xff10 + 0x30) // fullwidth
  if (cp === 0x24ea) return '0' // ⓪ circled zero
  if (cp >= 0x2460 && cp <= 0x2468) return String.fromCharCode(cp - 0x2460 + 0x31) // ①..⑨
  if (cp >= 0x2474 && cp <= 0x247c) return String.fromCharCode(cp - 0x2474 + 0x31) // ⑴..⑼ paren
  if (cp >= 0x2776 && cp <= 0x277e) return String.fromCharCode(cp - 0x2776 + 0x31) // ❶..❾ neg circled
  // Mathematical digit blocks (bold, double-struck, sans, mono, etc.) are 8
  // contiguous 10-codepoint ranges starting at U+1D7CE.
  if (cp >= 0x1d7ce && cp <= 0x1d7ff) return String.fromCharCode(((cp - 0x1d7ce) % 10) + 0x30)
  return null
}

/** Characters that, in a NUMERIC context, are commonly used as digits via leet
 *  ("5o5" where o=0, "l"=1). We only fold these to digits when they sit adjacent to
 *  real digits, so ordinary words ("hello") are not turned into digit soup. */
const LEET_DIGIT: Record<string, string> = {
  o: '0',
  i: '1',
  l: '1',
  s: '5',
  z: '2',
  b: '8',
  g: '9',
  q: '9',
}

/** Build the count of TOTAL digits in a message, tolerant of every grouping /
 *  separator / unicode-digit evasion. We:
 *    1. NFKD-decompose and DROP combining marks + the keycap-combiner U+20E3 and
 *       variation selectors, so "5️⃣" collapses to "5".
 *    2. Fold each codepoint through unicodeDigit() to ascii 0-9 where possible.
 *    3. Additionally, fold leet letters (o,i,l,s,...) to digits ONLY when they are
 *       immediately adjacent to a real digit (numeric context), so "5o5 123" counts
 *       o as 0 but "hello" stays untouched.
 *  Returns the digit-only string; its length is the total digit count. Separators
 *  never appear here because non-digits are simply skipped. */
function digitFold(text: string): string {
  // Strip combining marks, variation selectors, keycap combiner, zero-width chars.
  const cleaned = text
    .normalize('NFKD')
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[̀-ͯ︀-️⃣​-‍⁠﻿­]/g, '')

  const chars = Array.from(cleaned.toLowerCase())
  // First pass: classify each char as a digit (from unicode) or a leet-candidate.
  const slots: { digit: string | null; leet: string | null }[] = []
  for (const ch of chars) {
    const cp = ch.codePointAt(0)
    if (cp === undefined) {
      slots.push({ digit: null, leet: null })
      continue
    }
    const d = unicodeDigit(cp)
    if (d !== null) {
      slots.push({ digit: d, leet: null })
    } else {
      slots.push({ digit: null, leet: LEET_DIGIT[ch] ?? null })
    }
  }
  // Second pass: promote a leet-candidate to a digit only if it neighbours a real
  // (or already-promoted) digit, so a leet run riding a phone number ("5o5o123")
  // folds wholesale while stray letters do not.
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].digit !== null || slots[i].leet === null) continue
      const prev = i > 0 ? slots[i - 1].digit : null
      const next = i < slots.length - 1 ? slots[i + 1].digit : null
      if (prev !== null || next !== null) {
        slots[i].digit = slots[i].leet
        slots[i].leet = null
        changed = true
      }
    }
  }
  let out = ''
  for (const s of slots) if (s.digit !== null) out += s.digit
  return out
}

// ---------------------------------------------------------------------------
// DETECTORS  (run in priority order against the normalized form)
// ---------------------------------------------------------------------------

/** True if `needle` appears in either the normalized or the fully-collapsed form.
 *  Two forms because collapse-to-2 keeps real doubles for readability while
 *  collapse-all defeats double-letter padding evasion. */
function containsAny(normalized: string, collapsed: string, list: readonly string[]): boolean {
  for (const term of list) {
    // Primary form keeps real double letters (runs of 2) but kills 3+ padding,
    // so "fuuuuck" -> "fuck" is already caught here.
    if (normalized.includes(term)) return true
    // Backstop for DOUBLE-letter padding ("fuuck", "ffuucckk"): collapse EVERY
    // run in the TEXT to a single char and match the ORIGINAL term against it.
    // IMPORTANT: we do NOT collapse the term — collapsing "piss" -> "pis" would
    // make it match innocent "zip is", a false positive. Matching the full term
    // against the collapsed text means a real double-lettered root like "piss"
    // simply won't fire on padding, which is the safe failure direction.
    if (collapsed.includes(term)) return true
  }
  return false
}

/** Consonant skeletons for CENSOR-STAR evasion ("f*ck", "sh*t", "b*tch"), where a
 *  vowel is replaced by a non-leet symbol that the separator strip removes,
 *  leaving e.g. "fck" / "sht" / "btch". We deliberately do NOT vowel-strip the
 *  whole profanity list: skeletons like "spc" (from "spic") or "nds" (from
 *  "nudes") collide with innocent gameplay ("press space", "i found a secret"),
 *  causing bad false positives. Instead this is a tiny, HAND-PICKED allowlist of
 *  skeletons that are (a) distinctive enough not to collide with normal words and
 *  (b) the realistic censor-star targets a kid actually types. Extend cautiously:
 *  each entry must be a skeleton that does not appear inside common English. */
const CENSOR_SKELETONS: readonly string[] = [
  'fck', // f*ck, f**k
  'fk', // 'fk' is short but a real standalone insult abbreviation
  'sht', // sh*t
  'btch', // b*tch
  'bstrd', // b*stard
  'sshl', // a**hole
  'dckh', // d*ckhead
  'pssy', // p*ssy
  'cnt', // c*nt
  'fckr', // f*cker
  'nggr', // n*gg*r (slur, hard block)
  'fggt', // f*gg*t (slur, hard block)
]

/** CENSOR-STAR backstop, profanity only. Vowel-strip the (already collapsed)
 *  text and look for any distinctive skeleton above. Narrow by construction so it
 *  doesn't fire on ordinary chat. Never used for the contact category. */
function matchesCensorSkeleton(collapsed: string): boolean {
  const stripped = collapsed.replace(/[aeiou]/g, '')
  for (const skel of CENSOR_SKELETONS) {
    if (stripped.includes(skel)) return true
  }
  return false
}

// --- MEETUP carve-out --------------------------------------------------------
//
// SAFETY-CRITICAL: the grooming/contact category must block real-world / off-
// platform meetup attempts ("meet me at the mall tonight", "meet me irl"). But it
// was over-blocking legitimate IN-GAME coordination ("meet me at the arcade
// portal"). This carve-out lets ONLY the narrow, demonstrably-safe in-game shape
// through; EVERYTHING else in the meetup family still BLOCKS by default.
//
// How it works:
//   - MEETUP_KEYWORDS are the joined-ascii meetup triggers, matched against the
//     normalized view exactly like the other contact keyword sets.
//   - When a message trips a meetup keyword, it BLOCKS unless isSafeInGameMeetup()
//     returns true. That function returns true ONLY when the message is a
//     "meet/see (you/me) at/by/near the <IN-GAME PLACE>" shape AND carries NO
//     other red flag (no real-world place/time/IRL signal, and — enforced by the
//     normal detector order — no digits/email/url/@handle/address, which trip the
//     other contact rules first and never reach this carve-out).
//
// Default remains BLOCK. This is a carve-out on an existing block, not a new
// broad allow.

/** Meetup triggers that BENEFIT from the in-game carve-out. Matched against the
 *  normalized (separator-stripped, de-leet) view. */
const MEETUP_KEYWORDS: readonly string[] = ['meetme', 'meetup']

/** Meetup phrasings that are ALWAYS real-world and must NEVER be carved out.
 *  These explicitly name "real life" / "irl", so there is no safe in-game reading.
 *  Matched against the normalized view. (GROOMING_PHRASES also covers "meetirl" /
 *  "meetinreallife"; these are kept here too as a belt-and-suspenders block.) */
const MEETUP_REALWORLD_ALWAYS: readonly string[] = [
  'meetirl',
  'meetinrealife',
  'meetinreallife',
  'meetinperson',
]

/** IN-GAME location allowlist. These are VIRTUAL places in Unit 7 (arcade, portal,
 *  moon base, etc.). A meetup that points at one of these — and nothing else
 *  suspicious — is legitimate gameplay coordination. Curated and intentionally
 *  narrow; matched as whole word tokens. Multi-word places ("moon base", "dance
 *  floor") are matched as joined tokens against the separator-stripped form. */
const INGAME_PLACES: readonly string[] = [
  'arcade',
  'portal',
  'plaza',
  'spawn',
  'moon',
  'mars',
  'base',
  'moonbase',
  'tower',
  'gate',
  'ramp',
  'rooftop',
  'roof',
  'dancefloor',
  'trampoline',
  'hoverboard',
  'mech',
  'rocket',
  'beacon',
  'ring',
  'course',
  'track',
  'dome',
  'start',
  'top',
  'map',
  'lobby',
  'hub',
  'here',
  'there',
]

/** REAL-WORLD meetup signals. If ANY of these is present, the meetup carve-out is
 *  DENIED and the message blocks — even if it also names an in-game place. These
 *  are the genuine-danger signals: off-platform / real-life / real-place / time /
 *  in-person pickup. Tested against the lightly-cleaned lowercased text with word
 *  boundaries (so "park" doesn't fire inside "sparkle"). */
function hasRealWorldMeetupSignal(lightLower: string): boolean {
  // IRL / real-life / in-person markers.
  if (/\b(irl|in real life|real life|in person|in the flesh)\b/.test(lightLower)) return true
  // Home / house / "my place" / coming over / pickup / "where do you live".
  if (/\b(my|your|ur)\s*(house|home|place|apartment|apt|crib)\b/.test(lightLower)) return true
  if (/\b(come over|come to my|pick (you|u) up|where do (you|u|ya) live|come round|swing by)\b/.test(lightLower))
    return true
  // School-day / time-of-day / day signals (a meetup pinned to real time = IRL).
  if (/\bafter school\b/.test(lightLower)) return true
  if (/\b(tonight|tomorrow|today|tonite|this weekend|this week|next week|later today)\b/.test(lightLower)) return true
  if (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(lightLower)) return true
  if (/\b\d{1,2}\s*(am|pm|oclock|o'clock)\b/.test(lightLower)) return true
  if (/\bat\s+\d{1,2}(:\d{2})?\b/.test(lightLower)) return true // "at 5", "at 5:30"
  if (/\bat\s+(noon|midnight|lunch|dinner|breakfast|recess)\b/.test(lightLower)) return true
  // Real-world places a child might name.
  const realPlaces = [
    'park',
    'mall',
    'school',
    'home',
    'store',
    'shop',
    'starbucks',
    'mcdonalds',
    'mcdonald',
    'wendys',
    'walmart',
    'target',
    'downtown',
    'uptown',
    'corner',
    'library',
    'church',
    'gym',
    'cafe',
    'restaurant',
    'station',
    'airport',
    'hotel',
    'motel',
    'street',
    'avenue',
    'road',
    'neighborhood',
    'town',
    'city',
    'village',
    'address',
  ]
  const words = lightLower.split(/[^a-z]+/).filter(Boolean)
  const wordSet = new Set(words)
  for (const p of realPlaces) if (wordSet.has(p)) return true
  // "my town" / "my city" already covered by the word-set above ("town"/"city").
  return false
}

/** Does the message name an IN-GAME place (whole-word / joined-token match)?
 *  We test BOTH the word-token view (so "moon", "arcade" match) AND the
 *  separator-stripped normalized view (so "moon base" -> "moonbase",
 *  "dance floor" -> "dancefloor" match the joined entries). */
function namesInGamePlace(lightLower: string, normalized: string): boolean {
  const words = lightLower.split(/[^a-z]+/).filter(Boolean)
  const wordSet = new Set(words)
  for (const p of INGAME_PLACES) {
    if (wordSet.has(p)) return true
    // joined multi-word place (e.g. "moonbase", "dancefloor") in the stripped form.
    if (p.length >= 6 && normalized.includes(p)) return true
  }
  return false
}

/** The narrow SAFE shape: a "meet/see (you/me) ... <in-game place>" message that
 *  names an in-game location and carries NO real-world meetup signal. Returns true
 *  ONLY for this safe shape; anything else returns false (-> block stays).
 *
 *  Note: digit/email/url/@handle/address red flags are caught by detectors that
 *  run BEFORE the meetup carve-out in filterChat, so by the time this is consulted
 *  the message has already cleared those. We still require an in-game place AND no
 *  real-world signal here as the explicit gate. */
function isSafeInGameMeetup(lightLower: string, normalized: string): boolean {
  // Phrasings that are intrinsically real-world ("meet irl") can never be safe.
  if (containsAny(normalized, collapseAll(normalized), MEETUP_REALWORLD_ALWAYS)) return false
  // Must be a "meet/see" lead-in (the verb that triggered the carve-out).
  if (!/\b(meet|see)\b/.test(lightLower)) return false
  // Any real-world meetup signal denies the carve-out.
  if (hasRealWorldMeetupSignal(lightLower)) return false
  // Must point at an in-game place.
  if (!namesInGamePlace(lightLower, normalized)) return false
  return true
}

// --- CONTACT detectors -------------------------------------------------------

/** Phone numbers: any run of 7+ digits, OR shorter digit groups that together add
 *  up to a phone-shaped sequence once separators are gone. Because normalization
 *  strips separators AND de-leets, "555-123-4567", "5 5 5 1 2 3 4", "S5S i23"
 *  all surface their digits here. We treat 7+ contiguous digits as a phone share.
 *  (US local numbers are 7; with area code 10; international up to ~15.) */
function looksLikePhone(normalized: string): boolean {
  // After de-leet, letters like s/o/i may have been digits; we re-scan the
  // ORIGINAL-ish normalized string for digit runs. But de-leet turned digits INTO
  // letters, so we must scan a form where leet is NOT applied for the pure-digit
  // case. That is handled separately in looksLikeBareNumber on a digit-preserving
  // pass. Here we catch digits that remain after normalization (rare).
  return /\d{7,}/.test(normalized)
}

/** Whole-word platform mention ("steam", "discord", "psn", "xbox", ...). Matched
 *  against word TOKENS (not as a raw substring) so "steam" doesn't fire inside
 *  "lets team". We de-leet each token first so "d1scord"/"r0blox" still match. */
function mentionsContactPlatform(rawLower: string): boolean {
  // Split on anything that isn't a letter/digit/leet-glyph, then de-leet+strip the
  // token so "d1sc0rd" / "x b o x"(already split) reduces to the bare platform.
  const tokens = rawLower.split(/[^a-z0-9@!|$]+/).filter(Boolean)
  for (const tok of tokens) {
    let t = ''
    for (const ch of tok) t += LEET[ch] ?? ch
    t = t.replace(SEPARATORS, '')
    if ((CONTACT_PLATFORM_TOKENS as readonly string[]).includes(t)) return true
  }
  return false
}

/** Spelled-out digits: 3+ number-words in a row ("five five five one two ...").
 *  We tokenize the ORIGINAL lowercased text on word boundaries (not the
 *  separator-stripped form, since we need word boundaries) and look for a run. */
function spelledOutNumberRun(rawLower: string): boolean {
  const words = rawLower.split(/[^a-z]+/).filter(Boolean)
  let run = 0
  for (const w of words) {
    if ((NUMBER_WORDS as readonly string[]).includes(w)) {
      run++
      if (run >= 3) return true
    } else {
      run = 0
    }
  }
  // CONCATENATED spelled digits ("fivefivefive onetwothree"): greedily chunk each
  // word-token into digit-words. A token that decomposes entirely into >= 2 digit
  // words, summed across the message to >= 5 total digit-words, is a number share.
  // We require WHOLE-TOKEN decomposition so an ordinary word ("everyone" ->
  // "every"+"one"?) does not falsely chunk: "everyone" fails because "every" is not
  // a digit word, so the greedy parse rejects the token entirely.
  let total = 0
  for (const w of words) {
    const n = countConcatenatedDigitWords(w)
    if (n >= 2) total += n // only count tokens that are clearly digit-runs
  }
  if (total >= 5) return true
  return false
}

/** If `word` is ENTIRELY a concatenation of digit-words ("fivefivefive" ->
 *  ["five","five","five"]), return how many digit-words it contains; else 0.
 *  Greedy longest-match from the front; any leftover non-digit-word residue means
 *  the token is not a pure digit run, so we return 0 (no partial credit). */
function countConcatenatedDigitWords(word: string): number {
  let i = 0
  let count = 0
  outer: while (i < word.length) {
    for (const dw of DIGIT_WORDS) {
      if (word.startsWith(dw, i)) {
        i += dw.length
        count++
        continue outer
      }
    }
    return 0 // residue that isn't a digit word -> not a pure digit-word token
  }
  return count
}

/** ROOT-CAUSE phone rule: count TOTAL digits in the message regardless of grouping.
 *  A phone number is 7+ digits however it's split ("555-123-4567", "5 5 5 1 2 3 4",
 *  fullwidth/keycap/leet digits). Game numbers stay well under 7 ("scored 9000" = 4,
 *  "level 7" = 1, "3 lives and 5 stars" = 2), so 7 is a safe floor. */
function looksLikeTotalDigits(text: string): boolean {
  return digitFold(text).length >= 7
}

/** COMBINED number-token rule. A phone can be written by MIXING forms — ascii/
 *  unicode digits AND spelled number-words in one string ("5 five 5 1 2 3 4"), so
 *  it slips under BOTH the 7-ascii-digit rule and the 5-spelled-word rule when each
 *  is counted alone. Here we tally them TOGETHER: every folded numeric character
 *  (ascii/fullwidth/keycap/circled, leet-in-context) counts 1, and every spelled
 *  digit-word (spaced or concatenated) counts 1. >= 7 combined number-tokens blocks.
 *
 *  Game phrases stay safe because they don't stack number-tokens: "i have 3 lives
 *  and 5 stars" = 2, "level 7" = 1, "i scored 2048" = 4, "3 2 1 go" = 3 — all < 7.
 *  Spelled words counted here are the unambiguous DIGIT_WORDS only (no "to"/"for"/
 *  "ate" homophones), so "i want to win for sure" contributes 0. */
function combinedNumberTokenCount(rawLower: string, clean: string): number {
  const digitCount = digitFold(clean).length
  let wordCount = 0
  for (const w of rawLower.split(/[^a-z]+/).filter(Boolean)) {
    if ((DIGIT_WORDS as readonly string[]).includes(w)) {
      wordCount++
    } else {
      // concatenated digit-word token ("fivefive") contributes its chunk count
      wordCount += countConcatenatedDigitWords(w)
    }
  }
  return digitCount + wordCount
}

/** LOCATION disclosure: real-world city/state names introduced by a geo lead-in
 *  ("i'm from", "i live in"), bare US-state / well-known-city mentions, and postal
 *  codes (UK postcode, US zip). Gated on REAL geography keywords so in-game
 *  location phrasing ("from the moon base", "in the arcade") stays allowed. */
function looksLikeLocation(lightLower: string): boolean {
  const words = lightLower.split(/[^a-z]+/).filter(Boolean)
  const wordSet = new Set(words)
  // Bare real-world place name anywhere (these don't collide with game vocab).
  for (const st of US_STATES) if (wordSet.has(st)) return true
  for (const ct of REAL_CITIES) if (wordSet.has(ct)) return true
  // "from/live/in/stay <Place>" lead-in followed by a Capitalized-looking proper
  // noun is too broad; instead we rely on the curated lists above for names and
  // add postal-code patterns here.
  // UK postcode: e.g. "SW1A 1AA", "M1 1AE", "EC1A 1BB".
  if (/\b[a-z]{1,2}\d[a-z\d]?\s*\d[a-z]{2}\b/i.test(lightLower)) return true
  // US ZIP introduced by a zip lead-in OR a bare 5-digit "from/in" geo context.
  if (/\bzip\b/.test(lightLower) && /\b\d{5}(-\d{4})?\b/.test(lightLower)) return true
  return false
}

/** Age sharing: "<n> years old", "<n> yo", "<n> yrs old", or "im <n>" where n is a
 *  child-plausible age. Age is personal info a groomer fishes for, so we block it
 *  regardless of the "i am" phrasing (which we no longer keyword on). Number-words
 *  are covered too ("nine years old"). */
function looksLikeAgeShare(lightLower: string, normalized: string): boolean {
  if (/\b(\d{1,2})\s*(years?\s*old|yrs?\s*old|y\/?o)\b/.test(lightLower)) return true
  if (
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)\s*(years?\s*old|yrs?\s*old)\b/.test(
      lightLower,
    )
  )
    return true
  // "im 9" / "i am 12" stated as an age-looking bare statement.
  if (/\bi\s*a?m\s*\d{1,2}\b\s*(years?|yrs?|yo)?/.test(lightLower) && /\b\d{1,2}\s*(years?|yrs?|yo)\b/.test(lightLower))
    return true
  // "im 8 and a half" — a bare "im <small age> and a half" is an age disclosure.
  if (/\bi('?m| am)\s*\d{1,2}\s*and\s*a\s*half\b/.test(lightLower)) return true
  // Spelled-out age survives separator evasion ("im n.i.n.e years old") via the
  // normalized view: "<number-word>yearsold" / "<number-word>yrsold".
  if (
    /(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)(years?old|yrsold)/.test(
      normalized,
    )
  )
    return true
  // "<digit>yearsold" in the normalized (de-dotted) view.
  if (/\d{1,2}(years?old|yrsold|yo)\b/.test(normalized)) return true
  return false
}

/** Email address: local@domain. Detected on a digit/letter-preserving pass.
 *  After normalization "@" becomes "a", so we test the lightly-cleaned text that
 *  still has "@" and ".". */
function looksLikeEmail(lightLower: string, compact: string): boolean {
  // De-leet copies so a leetspeak email ("j0hn@gmai1.c0m") surfaces a real tld.
  // We fold ONLY digit-leet (0->o, 1->i, 3->e, 5->s, 7->t) so "c0m"->"com",
  // "gmai1"->"gmail" — we must NOT fold "@" (->a) since it carries the email shape.
  const DIGIT_LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '5': 's', '7': 't' }
  const deleet = (s: string) => {
    let o = ''
    for (const ch of s) o += DIGIT_LEET[ch] ?? ch
    return o
  }
  const lightDeleet = deleet(lightLower)
  const compactDeleet = deleet(compact)
  // user@host.tld with optional spaces around the @ that a kid might add.
  const at = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/
  if (at.test(lightLower) || at.test(compact)) return true
  if (at.test(lightDeleet) || at.test(compactDeleet)) return true
  // spelled-out "<word> at <word> dot com"
  if (/\bat\b.*\bdot\b\s*(com|net|org|co|io|gov|edu)/.test(lightLower)) return true
  return false
}

/** Street address: a number (digit OR spelled-out) followed by a street-type word,
 *  plus cross-street shapes ("5th and main", "elm and oak"). Real-world location. */
function looksLikeAddress(lightLower: string): boolean {
  const streetType =
    '(street|st|avenue|ave|road|rd|lane|ln|drive|dr|blvd|boulevard|court|ct|way|circle|cir|place|pl|terrace|highway|hwy|route|elm|oak|maple|pine|main)'
  // digit house number + street type
  if (
    new RegExp(`\\b\\d{1,6}\\s+([a-z]+\\s+)*${streetType}\\b`).test(lightLower)
  )
    return true
  // spelled-out house number ("house number is fourteen on elm", "fourteen on elm")
  const numWord =
    '(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)'
  if (
    new RegExp(`\\bhouse\\s*(number|num|no)\\b`).test(lightLower) ||
    new RegExp(`\\b${numWord}\\s+(on|at)\\s+([a-z]+\\s+)*${streetType}\\b`).test(lightLower)
  )
    return true
  // cross-street: "<ordinal> and main", "5th and main", "elm and oak"
  if (/\b(\d{1,3}(st|nd|rd|th)|[a-z]+)\s+and\s+(main|elm|oak|maple|pine|broadway|[0-9]+(st|nd|rd|th))\b/.test(lightLower))
    return true
  return false
}

/** SCHOOL / GRADE / TEACHER / CLASSROOM disclosure. Real-world identity context.
 *  Gated on school vocabulary, so in-game phrasing is unaffected. */
function looksLikeSchoolOrIdentity(lightLower: string): boolean {
  if (/\bschool\b/.test(lightLower)) return true
  if (/\b(grade|teacher|classroom|homeroom)\b/.test(lightLower)) return true
  if (/\b(mr|mrs|ms|miss|mister)\s+[a-z]+(s)?\s+(class|room)\b/.test(lightLower)) return true
  if (/\broom\s*\d{1,3}\b/.test(lightLower)) return true
  if (/\b(elementary|kindergarten)\b/.test(lightLower)) return true
  if (/\bgo\s+to\s+[a-z]+\s+(elementary|middle|high|elem)\b/.test(lightLower)) return true
  if (/\bgrade\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/.test(lightLower)) return true
  // "irl im called <name>" / "im called <name>" real-name disclosure
  if (/\b(irl\s+)?i('?m| am)\s+called\b/.test(lightLower)) return true
  // birthday/bday reveal
  if (/\b(bday|birthday)\b/.test(lightLower)) return true
  return false
}

/** Social-handle share: an "@" immediately followed by handle characters
 *  ("@coolkid99"). A bare @handle is a third-party contact share with no benign
 *  in-game use. We run on the lightly-cleaned text (homoglyphs folded, "@" intact).
 *  We require >= 3 trailing handle chars so a stray "@" doesn't fire. */
function looksLikeAtHandle(lightLower: string): boolean {
  return /@[a-z0-9._]{3,}/.test(lightLower)
}

// --- LINK detector -----------------------------------------------------------

/** `compact` = lightLower with ALL whitespace removed but "." "@" "/" kept. This
 *  defeats spaced-out URLs ("w w w . bad . com", "bad . com") which otherwise slip
 *  past the dot-domain regex. We do NOT repeat-collapse it (so "www" survives). */
function looksLikeLink(lightLower: string, compact: string): boolean {
  if (/https?:\/\//.test(lightLower) || /https?:\/\//.test(compact)) return true
  // Defanged scheme "hxxp://" / "hxxps://".
  if (/hxxps?:\/\//.test(lightLower) || compact.includes('hxxp')) return true
  // "www" — check the compact form so spaced "w w w" -> "www" is caught (the
  // normalized form repeat-collapses "www" -> "w", so it CANNOT be used here).
  if (/\bwww\b/.test(lightLower) || compact.includes('www')) return true
  // a bare domain like "foo.com" / "foo.co.uk", in either spaced or compact form.
  const domain = /[a-z0-9-]+\.(com|net|org|io|co|gg|tv|me|app|xyz|info|biz|us|uk|edu|gov|ee|ly)\b/
  if (domain.test(lightLower) || domain.test(compact)) return true
  // Known URL shorteners / link aggregators (with any dot variant collapsed).
  const shorteners = ['linktr.ee', 'tinyurl', 'bit.ly', 't.co', 'discord.gg', 'cash.app']
  for (const s of shorteners) {
    if (compact.includes(s) || compact.includes(s.replace('.', ''))) return true
  }
  // spelled-out / bracketed "dot" + tld evasion: "site dot com", "mysite (dot) com",
  // "site [.] com". Normalize bracketed/spelled dots then look for "dot<tld>".
  const dotted = lightLower
    .replace(/\(\s*dot\s*\)/g, 'dot')
    .replace(/\[\s*\.?\s*\]/g, 'dot')
    .replace(/\{\s*dot\s*\}/g, 'dot')
  if (/\bdot\s*(com|net|org|io|co|gg|tv|me|ee|ly|app|xyz)\b/.test(dotted)) return true
  if (compact.includes('dotcom') || compact.includes('dotnet') || compact.includes('dotorg')) return true
  // "<word> slash <path>" alongside a domain-ish or shortener mention = a URL share.
  if (/\bslash\b/.test(lightLower) && /\b(com|net|org|dot|tinyurl|bit|linktr|discord)\b/.test(lightLower)) return true
  if (compact.includes('http')) return true
  return false
}

// --- bare NUMBER detector ----------------------------------------------------

/** Long bare digit run on a DIGIT-PRESERVING pass (before de-leet). A run this long
 *  could be a phone fragment, zip code, or address.
 *
 *  THRESHOLD = 5 (not 4). Rationale: this game is score/level/credits-driven, so
 *  4-digit numbers are everywhere in benign chat ("scored 9000", "2048 is hard",
 *  and 2048 is literally one of the arcade cabinets). A bare 4-digit number cannot
 *  be a phone number (>=7 digits, already caught by looksLikePhone) or a full
 *  street address, so blocking it buys ZERO safety while wrecking normal play.
 *  5+ still catches zip codes and phone fragments. Contact-shaped digit shares
 *  ("call me at 1234", "my number 1234") are already caught by the contact
 *  keyword + spelled-out + phone detectors regardless of length. */
function looksLikeBareNumber(digitPreserving: string): boolean {
  return /\d{5,}/.test(digitPreserving)
}

// --- SPAM / GIBBERISH (lowest priority, best-effort) -------------------------

function looksLikeSpam(rawTrimmed: string): boolean {
  // ALL-CAPS wall: long, mostly letters, and (nearly) all uppercase = shouting.
  const letters = rawTrimmed.replace(/[^a-zA-Z]/g, '')
  if (letters.length >= 12) {
    const upper = rawTrimmed.replace(/[^A-Z]/g, '').length
    if (upper / letters.length > 0.9) return true
  }
  // Same character mashed many times ("aaaaaaaaaa", "!!!!!!!!").
  if (/(.)\1{9,}/.test(rawTrimmed)) return true
  // A single token with no vowels and many consonants = keyboard mash
  // ("asdfghjkl"). Only flag long, space-free, vowel-less alpha runs.
  const tokens = rawTrimmed.toLowerCase().split(/\s+/)
  for (const t of tokens) {
    if (t.length >= 10 && /^[a-z]+$/.test(t) && !/[aeiou]/.test(t)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// MAIN ENTRY
// ---------------------------------------------------------------------------

/**
 * Filter a candidate chat line. Returns a FilterVerdict:
 *   - allowed:false with a reason for anything blocked, OR
 *   - allowed:true, reason:'ok', text = the trimmed ORIGINAL (display-preserving).
 *
 * Detector priority (highest first): contact > profanity > link > number >
 * toolong > empty > spam/gibberish. Contact is checked first and most
 * aggressively because a leaked phone/address/handle is the worst outcome.
 */
export function filterChat(text: string): FilterVerdict {
  const trimmed = text.trim()

  // 'empty' is technically the cheapest reject, but length checks shouldn't mask a
  // contact/profanity attempt buried in whitespace-heavy input. We still short
  // out truly-empty input first; an empty string can't leak anything.
  if (trimmed.length === 0) {
    return { allowed: false, text: '', reason: 'empty' }
  }

  // 'toolong' is enforced up front to bound the work the detectors do AND because
  // the wire/UI contract caps length anyway. A child can't sneak data past the
  // length cap regardless of content.
  if (trimmed.length > CHAT_MAX_LEN) {
    return { allowed: false, text: trimmed.slice(0, CHAT_MAX_LEN), reason: 'toolong' }
  }

  // Strip zero-width / invisible chars up front so every derived view (raw, light,
  // compact) is immune to "sn<zwsp>ap" / "em<soft-hyphen>ail" evasion.
  // eslint-disable-next-line no-misleading-character-class
  const clean = trimmed.replace(/[​-‍⁠﻿­]/g, '')

  // Build the several views the detectors need.
  const rawLower = clean.toLowerCase()
  // "light" form: lowercased, diacritics + homoglyphs folded, but punctuation and
  // digits PRESERVED — needed for email/URL/address shapes that depend on "@", "."
  // and real digits.
  let light = ''
  for (const ch of clean.normalize('NFKD').replace(/[̀-ͯ]/g, '')) {
    const cp = ch.codePointAt(0)
    light += cp !== undefined ? mapHomoglyph(cp) ?? ch : ch
  }
  const lightLower = light.toLowerCase()
  // digit-preserving form for bare-number scans (light form already preserves
  // digits; reuse it).
  const digitPreserving = lightLower
  // compact form: lightLower with whitespace removed (dots/@/slash kept, NOT
  // repeat-collapsed) so spaced URLs/emails like "w w w . bad . com" reassemble.
  const compact = lightLower.replace(/\s+/g, '')

  const normalized = normalizeForMatch(trimmed)
  const collapsed = collapseAll(normalized)

  // --- 1. CONTACT (most important; default-deny on ambiguity) ----------------
  // These detectors are checked FIRST and unconditionally. Critically, they run
  // BEFORE the meetup carve-out, so a meetup line carrying a phone/email/url/
  // @handle/address/age/location red flag is blocked here and NEVER reaches the
  // narrow in-game allowance below.
  if (
    looksLikeEmail(lightLower, compact) ||
    looksLikeAddress(lightLower) ||
    looksLikeAgeShare(lightLower, normalized) ||
    looksLikePhone(normalized) ||
    looksLikePhone(digitPreserving) ||
    looksLikeTotalDigits(clean) ||
    combinedNumberTokenCount(rawLower, clean) >= 7 ||
    spelledOutNumberRun(rawLower) ||
    looksLikeLocation(lightLower) ||
    looksLikeSchoolOrIdentity(lightLower) ||
    looksLikeAtHandle(lightLower) ||
    mentionsContactPlatform(rawLower) ||
    looksLikeLink(lightLower, compact) ||
    containsAny(normalized, collapsed, GROOMING_PHRASES) ||
    containsAny(normalized, collapsed, IDENTITY_KEYWORDS) ||
    containsAny(normalized, collapsed, CONTACT_KEYWORDS)
  ) {
    return { allowed: false, text: '', reason: 'contact' }
  }

  // --- 1b. MEETUP (carve-out) ------------------------------------------------
  // The meetup family ("meet me", "meet up") blocks by DEFAULT. The ONLY exception
  // is the narrow, demonstrably-safe in-game shape (isSafeInGameMeetup): a
  // "meet/see ... <in-game place>" line with NO real-world meetup signal and — by
  // virtue of running after the contact block above — no digit/email/url/@handle/
  // address red flag. Anything else in the meetup family still BLOCKS.
  if (
    containsAny(normalized, collapsed, MEETUP_REALWORLD_ALWAYS) ||
    (containsAny(normalized, collapsed, MEETUP_KEYWORDS) && !isSafeInGameMeetup(lightLower, normalized))
  ) {
    return { allowed: false, text: '', reason: 'contact' }
  }

  // --- 2. PROFANITY / SLURS / SEXUAL ----------------------------------------
  if (containsAny(normalized, collapsed, PROFANITY) || matchesCensorSkeleton(collapsed)) {
    return { allowed: false, text: '', reason: 'profanity' }
  }

  // --- 3. LINK ---------------------------------------------------------------
  if (looksLikeLink(lightLower, compact)) {
    return { allowed: false, text: '', reason: 'link' }
  }

  // --- 4. bare NUMBER --------------------------------------------------------
  if (looksLikeBareNumber(digitPreserving)) {
    return { allowed: false, text: '', reason: 'number' }
  }

  // --- 5/6 length/empty already handled above --------------------------------

  // --- 7. SPAM / GIBBERISH (best-effort, lowest priority) --------------------
  if (looksLikeSpam(trimmed)) {
    return { allowed: false, text: '', reason: 'spam' }
  }

  // Clean: return the trimmed ORIGINAL so casing/punctuation survive for display.
  return { allowed: true, text: trimmed, reason: 'ok' }
}
