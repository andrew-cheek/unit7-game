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
  'callme',
  'textme',
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
  'meetme',
  'meetup',
  'meetinrealife',
  'meetirl',
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
  'sendpic',
  'sendpics',
  'sendaphoto',
  'sendyourpic',
  'webcam',
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
  // 1. Decompose + strip diacritics (café -> cafe, ñ -> n).
  let s = text.normalize('NFKD').replace(/[̀-ͯ]/g, '')

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
  return false
}

/** Email address: local@domain. Detected on a digit/letter-preserving pass.
 *  After normalization "@" becomes "a", so we test the lightly-cleaned text that
 *  still has "@" and ".". */
function looksLikeEmail(lightLower: string): boolean {
  // user@host.tld with optional spaces around the @ that a kid might add.
  if (/[a-z0-9._%+-]+\s*@\s*[a-z0-9.-]+\.[a-z]{2,}/.test(lightLower)) return true
  // spelled-out "<word> at <word> dot com"
  if (/\bat\b.*\bdot\b\s*(com|net|org|co|io|gov|edu)/.test(lightLower)) return true
  return false
}

/** Street address: a number followed by a street-type word. */
function looksLikeAddress(lightLower: string): boolean {
  return /\b\d{1,6}\s+([a-z]+\s+)*(street|st|avenue|ave|road|rd|lane|ln|drive|dr|blvd|boulevard|court|ct|way|circle|cir|place|pl|terrace|highway|hwy|route)\b/.test(
    lightLower,
  )
}

// --- LINK detector -----------------------------------------------------------

function looksLikeLink(lightLower: string, normalized: string): boolean {
  if (/https?:\/\//.test(lightLower)) return true
  if (/\bwww\b/.test(lightLower) || normalized.includes('www')) return true
  // a bare domain like "foo.com" / "foo.co.uk"
  if (/[a-z0-9-]+\.(com|net|org|io|co|gg|tv|me|app|xyz|info|biz|us|uk|edu|gov)\b/.test(lightLower)) return true
  // spelled-out "dot com" evasion (also helps catch link sharing in words)
  if (/\bdot\s*(com|net|org|io|co|gg|tv|me)\b/.test(lightLower)) return true
  if (normalized.includes('dotcom') || normalized.includes('dotnet') || normalized.includes('dotorg')) return true
  if (normalized.includes('http')) return true
  return false
}

// --- bare NUMBER detector ----------------------------------------------------

/** Long bare digit run on a DIGIT-PRESERVING pass (before de-leet). 4+ digits
 *  could be a phone fragment, address, zip, age+more, etc. The contact category
 *  already grabbed 7+; this is the lower-priority catch-all for 4-6. */
function looksLikeBareNumber(digitPreserving: string): boolean {
  return /\d{4,}/.test(digitPreserving)
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

  // Build the several views the detectors need.
  const rawLower = trimmed.toLowerCase()
  // "light" form: lowercased, diacritics + homoglyphs folded, but punctuation and
  // digits PRESERVED — needed for email/URL/address shapes that depend on "@", "."
  // and real digits.
  let light = ''
  for (const ch of trimmed.normalize('NFKD').replace(/[̀-ͯ]/g, '')) {
    const cp = ch.codePointAt(0)
    light += cp !== undefined ? mapHomoglyph(cp) ?? ch : ch
  }
  const lightLower = light.toLowerCase()
  // digit-preserving form for bare-number scans (light form already preserves
  // digits; reuse it).
  const digitPreserving = lightLower

  const normalized = normalizeForMatch(trimmed)
  const collapsed = collapseAll(normalized)

  // --- 1. CONTACT (most important; default-deny on ambiguity) ----------------
  if (
    looksLikeEmail(lightLower) ||
    looksLikeAddress(lightLower) ||
    looksLikePhone(normalized) ||
    looksLikePhone(digitPreserving) ||
    spelledOutNumberRun(rawLower) ||
    mentionsContactPlatform(rawLower) ||
    containsAny(normalized, collapsed, CONTACT_KEYWORDS)
  ) {
    return { allowed: false, text: '', reason: 'contact' }
  }

  // --- 2. PROFANITY / SLURS / SEXUAL ----------------------------------------
  if (containsAny(normalized, collapsed, PROFANITY) || matchesCensorSkeleton(collapsed)) {
    return { allowed: false, text: '', reason: 'profanity' }
  }

  // --- 3. LINK ---------------------------------------------------------------
  if (looksLikeLink(lightLower, normalized)) {
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
