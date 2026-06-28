// Adversarial test corpus for filterChat() in chatSafety.ts.
//
// RED TEAM ARTIFACT. Every entry here is a message a child or bad actor might
// send to leak personal/contact info or lure another player off-platform.
// The contract is simple: filterChat(text).allowed MUST be false for ALL of
// these. This file is data only — no imports, no logic — so it can be consumed
// by the filter's test suite without coupling.
//
// `reason` is the category the filter is expected to flag the message under.
// `note` documents the evasion technique so reviewers can see the coverage.

export const ATTACK_CASES: { text: string; reason: string; note: string }[] = [
  // ---------------------------------------------------------------------------
  // Phone numbers — plain
  // ---------------------------------------------------------------------------
  { text: "5551234567", reason: "number", note: "bare 10-digit phone, no separators" },
  { text: "my number is 5551234567", reason: "number", note: "bare phone with lead-in" },
  { text: "call 18005551234", reason: "number", note: "11-digit with leading 1" },
  { text: "text 5551234567 anytime", reason: "number", note: "bare phone, sms verb" },
  { text: "ph 5551234567", reason: "number", note: "abbreviated label + bare phone" },

  // Phone numbers — formatted
  { text: "555-123-4567", reason: "number", note: "dash-formatted phone" },
  { text: "(555) 123-4567", reason: "number", note: "parens area code, dash" },
  { text: "(555) 123 4567", reason: "number", note: "parens area code, spaces" },
  { text: "555.123.4567", reason: "number", note: "dot-separated phone" },
  { text: "555 123 4567", reason: "number", note: "space-separated phone" },
  { text: "call me at 555-123-4567", reason: "number", note: "formatted phone with verb" },
  { text: "my cell: 555-123-4567", reason: "number", note: "labeled formatted phone" },
  { text: "ring me 1-555-123-4567", reason: "number", note: "country prefix with dashes" },

  // Phone numbers — international
  { text: "+15551234567", reason: "number", note: "E.164 international, US" },
  { text: "+1 555 123 4567", reason: "number", note: "intl with spaces" },
  { text: "+44 7700 900123", reason: "number", note: "UK mobile, intl" },
  { text: "+91 98765 43210", reason: "number", note: "India mobile, intl" },
  { text: "00 1 555 123 4567", reason: "number", note: "00 intl dialing prefix" },
  { text: "tel:+15551234567", reason: "number", note: "tel: URI scheme" },

  // Phone numbers — spaced/split between digits (evasion)
  { text: "5 5 5 1 2 3 4 5 6 7", reason: "number", note: "every digit space-separated" },
  { text: "5-5-5-1-2-3-4-5-6-7", reason: "number", note: "every digit dash-separated" },
  { text: "5.5.5.1.2.3.4.5.6.7", reason: "number", note: "every digit dot-separated" },
  { text: "555 . 123 . 4567", reason: "number", note: "spaced dots around groups" },
  { text: "5_5_5_1_2_3_4_5_6_7", reason: "number", note: "underscore between digits" },
  { text: "five 5 5 one 2 3 four", reason: "number", note: "mix of word and digit forms" },

  // Phone numbers — spelled out
  { text: "five five five one two three four five six seven", reason: "number", note: "fully spelled digits" },
  { text: "five-five-five one-two-three four-five-six-seven", reason: "number", note: "spelled digits, dashes" },
  { text: "fivefivefive onetwothree", reason: "number", note: "spelled digits concatenated" },
  { text: "my num is five five five, one two three, four five six seven", reason: "number", note: "spelled with grouping commas" },
  { text: "oh five five five one two three", reason: "number", note: "oh for zero, spelled" },
  { text: "nine zero two one one one two", reason: "number", note: "spelled out with zero word" },

  // Phone numbers — emoji / fullwidth / unicode digits (evasion)
  { text: "５５５１２３４５６７", reason: "number", note: "fullwidth unicode digits" },
  { text: "５５５-１２３-４５６７", reason: "number", note: "fullwidth digits, ascii dashes" },
  { text: "call ⑤⑤⑤①②③④⑤⑥⑦", reason: "number", note: "circled number glyphs" },
  { text: "5️⃣5️⃣5️⃣1️⃣2️⃣3️⃣4️⃣", reason: "number", note: "keycap emoji digits" },
  { text: "𝟓𝟓𝟓𝟏𝟐𝟑𝟒𝟓𝟔𝟕", reason: "number", note: "mathematical bold digits" },
  { text: "five⑤5 one①1 two②", reason: "number", note: "mixed glyph styles per digit" },

  // Phone numbers — mixed / disguised in sentence
  { text: "call me at 555 123 hey its urgent 4567", reason: "number", note: "digits split by filler words" },
  { text: "area 555 then 123 then 4567 ok", reason: "number", note: "narrated digit groups" },
  { text: "the code is 555123 and 4567", reason: "number", note: "phone disguised as a code" },
  { text: "5five5five5five123", reason: "number", note: "alternating digit and word forms" },

  // ---------------------------------------------------------------------------
  // Emails
  // ---------------------------------------------------------------------------
  { text: "email me at john.doe@gmail.com", reason: "contact", note: "standard email address" },
  { text: "kid123@yahoo.com", reason: "contact", note: "bare email" },
  { text: "reach me: first.last@outlook.com", reason: "contact", note: "labeled email" },
  { text: "name at gmail dot com", reason: "contact", note: "at/dot spelled out" },
  { text: "john [at] gmail [dot] com", reason: "contact", note: "bracketed at/dot" },
  { text: "john(at)gmail(dot)com", reason: "contact", note: "parens at/dot" },
  { text: "johnATgmailDOTcom", reason: "contact", note: "uppercase AT/DOT inline" },
  { text: "john @ gmail . com", reason: "contact", note: "spaced @ and . symbols" },
  { text: "john{at}gmail{dot}com", reason: "contact", note: "brace at/dot" },
  { text: "john at gmail period com", reason: "contact", note: "period spelled for dot" },
  { text: "j0hn@gmai1.c0m", reason: "contact", note: "leetspeak email" },
  { text: "jоhn@gmаil.com", reason: "contact", note: "cyrillic homoglyph letters in email" },
  { text: "ｊｏｈｎ＠ｇｍａｉｌ．ｃｏｍ", reason: "contact", note: "fullwidth email chars" },
  { text: "mail: kiddo underscore 9 at proton dot me", reason: "contact", note: "underscore spelled, alt domain" },

  // ---------------------------------------------------------------------------
  // Home address / location sharing
  // ---------------------------------------------------------------------------
  { text: "i live at 12 oak street", reason: "contact", note: "explicit street address" },
  { text: "my address is 4421 maple ave apt 3", reason: "contact", note: "address with unit" },
  { text: "come to my house its 88 pine road", reason: "contact", note: "invite + address" },
  { text: "i live in springfield", reason: "contact", note: "city disclosure" },
  { text: "im from chicago illinois", reason: "contact", note: "city + state disclosure" },
  { text: "my zip is 90210", reason: "contact", note: "zip code" },
  { text: "postcode SW1A 1AA", reason: "contact", note: "UK postcode" },
  { text: "we're at 12 oak st, apt b, near the school", reason: "contact", note: "address + landmark" },
  { text: "house number is fourteen on elm", reason: "contact", note: "house number spelled out" },
  { text: "i stay by 5th and main", reason: "contact", note: "cross-street location" },
  { text: "my house is the blue one on 12 oak", reason: "contact", note: "descriptive home locator" },
  { text: "lat 40.7128 long -74.0060", reason: "contact", note: "GPS coordinates" },

  // ---------------------------------------------------------------------------
  // Real name / age / school sharing
  // ---------------------------------------------------------------------------
  { text: "my real name is emily johnson", reason: "contact", note: "real full name disclosure" },
  { text: "irl im called tommy", reason: "contact", note: "real first name via irl" },
  { text: "i am 9 years old", reason: "contact", note: "age disclosure" },
  { text: "im 8 and a half", reason: "contact", note: "age, fractional" },
  { text: "i am 9 years old and go to lincoln elementary", reason: "contact", note: "age + school" },
  { text: "im in grade 3 at jefferson school", reason: "contact", note: "grade + school" },
  { text: "i go to oakwood middle school", reason: "contact", note: "school name" },
  { text: "my teacher is mrs smith at maple elementary", reason: "contact", note: "teacher + school" },
  { text: "im in mr lees class room 12", reason: "contact", note: "classroom identifier" },
  { text: "my bday is march 3 2017", reason: "contact", note: "birthdate reveals age" },
  { text: "real name tommy age 9 school lincoln", reason: "contact", note: "stacked identity disclosure" },

  // ---------------------------------------------------------------------------
  // Meetup / grooming red flags
  // ---------------------------------------------------------------------------
  { text: "lets meet irl", reason: "contact", note: "in-real-life meetup request" },
  { text: "meet me at the park at 3", reason: "contact", note: "specific meetup time/place" },
  { text: "where do you live", reason: "contact", note: "soliciting address" },
  { text: "whats your address", reason: "contact", note: "soliciting address, direct" },
  { text: "send me a pic of you", reason: "contact", note: "image solicitation" },
  { text: "send a selfie", reason: "contact", note: "selfie solicitation" },
  { text: "can you turn on your camera", reason: "contact", note: "camera/video solicitation" },
  { text: "add me so we can talk private", reason: "contact", note: "move to private channel" },
  { text: "dm me", reason: "contact", note: "direct-message solicitation" },
  { text: "lets talk somewhere else not here", reason: "contact", note: "off-platform move" },
  { text: "dont tell your parents about us", reason: "contact", note: "secrecy / grooming flag" },
  { text: "how old are you really", reason: "contact", note: "age probing" },
  { text: "are your parents home right now", reason: "contact", note: "supervision probing" },
  { text: "i can come pick you up", reason: "contact", note: "in-person pickup offer" },
  { text: "what school do you go to", reason: "contact", note: "soliciting school" },

  // ---------------------------------------------------------------------------
  // Social handles / platforms
  // ---------------------------------------------------------------------------
  { text: "find me on snapchat", reason: "contact", note: "platform name-drop, snapchat" },
  { text: "my snap is coolkid99", reason: "contact", note: "snap handle" },
  { text: "add me on insta @coolkid", reason: "contact", note: "instagram handle with @" },
  { text: "im on tiktok as @dancer123", reason: "contact", note: "tiktok handle" },
  { text: "my discord is name#1234", reason: "contact", note: "discord tag legacy format" },
  { text: "discord: coolkid_99", reason: "contact", note: "discord new username" },
  { text: "play with me on roblox username xXgamerXx", reason: "contact", note: "roblox username" },
  { text: "sub to my youtube channel kidgamer", reason: "contact", note: "youtube channel handle" },
  { text: "follow me @coolkid99", reason: "contact", note: "bare @handle" },
  { text: "im whatsapp at 5551234567", reason: "contact", note: "whatsapp + phone" },
  { text: "kik me at coolkid", reason: "contact", note: "kik handle" },
  { text: "telegram me @coolkid", reason: "contact", note: "telegram handle" },
  { text: "my gamertag is ProSniper42 on xbox", reason: "contact", note: "xbox gamertag" },
  { text: "find me on snap, sn@p name coolkid", reason: "contact", note: "snap with leetspeak duplicate" },

  // ---------------------------------------------------------------------------
  // Links
  // ---------------------------------------------------------------------------
  { text: "check out mysite.com", reason: "link", note: "bare domain" },
  { text: "https://evil-grooming.example/join", reason: "link", note: "full https url" },
  { text: "http://bit.ly/abc123", reason: "link", note: "http url shortener" },
  { text: "www.coolsite.net", reason: "link", note: "www-prefixed url" },
  { text: "join my server discord.gg/abcde", reason: "link", note: "discord invite link" },
  { text: "check out site dot com", reason: "link", note: "dot spelled out in url" },
  { text: "go to mysite (dot) com slash join", reason: "link", note: "dot+slash spelled" },
  { text: "visit my page at linktr.ee/coolkid", reason: "link", note: "link aggregator url" },
  { text: "tinyurl com slash abc", reason: "link", note: "shortener with spelled separators" },
  { text: "hxxp://sketchy.example", reason: "link", note: "defanged hxxp scheme" },
  { text: "my server: discord d0t gg slash join", reason: "link", note: "leetspeak dot + spelled slash" },

  // ---------------------------------------------------------------------------
  // Evasion — leetspeak across categories
  // ---------------------------------------------------------------------------
  { text: "whats your ph0ne number", reason: "number", note: "leetspeak 'phone'" },
  { text: "add me on sn@p", reason: "contact", note: "leetspeak 'snap'" },
  { text: "im on disc0rd", reason: "contact", note: "leetspeak 'discord'" },
  { text: "my 3mail is kid at gmail dot com", reason: "contact", note: "leetspeak 'email' label" },
  { text: "t3xt me at 555 123 4567", reason: "number", note: "leetspeak verb + phone" },
  { text: "ph0n3: 5o5 123 4567", reason: "number", note: "leet label + leet digits (o for 0)" },

  // Evasion — spacing/dots/dashes between letters of trigger words
  { text: "a d d   m e   o n   s n a p", reason: "contact", note: "letters of phrase spaced out" },
  { text: "d.i.s.c.o.r.d me", reason: "contact", note: "dotted letters of discord" },
  { text: "s-n-a-p-c-h-a-t", reason: "contact", note: "dashed letters of snapchat" },
  { text: "p h o n e   n u m b e r", reason: "number", note: "spaced 'phone number'" },
  { text: "e_m_a_i_l m_e", reason: "contact", note: "underscored letters of email" },

  // Evasion — repeated chars / stretched words
  { text: "snaaaaap me coolkid", reason: "contact", note: "elongated 'snap'" },
  { text: "disssscord name coolkid", reason: "contact", note: "elongated 'discord'" },
  { text: "phoooone 5551234567", reason: "number", note: "elongated 'phone'" },
  { text: "addddd me on insta", reason: "contact", note: "elongated 'add'" },

  // Evasion — unicode homoglyphs / fullwidth on words
  { text: "ѕnаpchаt me", reason: "contact", note: "cyrillic homoglyphs in snapchat" },
  { text: "ｄｉｓｃｏｒｄ ｍｅ", reason: "contact", note: "fullwidth 'discord me'" },
  { text: "аdd mе оn іnstа", reason: "contact", note: "cyrillic a/e/o/i homoglyphs" },
  { text: "ⓢⓝⓐⓟ ⓜⓔ", reason: "contact", note: "circled-letter snap me" },
  { text: "𝓼𝓷𝓪𝓹 𝓶𝓮", reason: "contact", note: "script-style unicode snap me" },

  // Evasion — zero-width / invisible chars inside trigger words
  { text: "sn​ap me coolkid", reason: "contact", note: "zero-width space inside snap" },
  { text: "disc‌ord name", reason: "contact", note: "zero-width non-joiner inside discord" },
  { text: "ph﻿one 5551234567", reason: "number", note: "BOM/zero-width no-break inside phone" },
  { text: "5​5​5​1​2​3​4​5​6​7", reason: "number", note: "zero-width between every digit" },
  { text: "em­ail me", reason: "contact", note: "soft hyphen inside email" },

  // Evasion — creative spelling / split words
  { text: "snap chat me at coolkid", reason: "contact", note: "split 'snapchat' into two words" },
  { text: "dis cord name coolkid", reason: "contact", note: "split 'discord'" },
  { text: "you tube channel kidgamer", reason: "contact", note: "split 'youtube'" },
  { text: "what is your numba", reason: "number", note: "slang spelling 'numba'" },
  { text: "gimme ur digits", reason: "number", note: "slang 'digits' for phone" },
  { text: "whats ur addy", reason: "contact", note: "slang 'addy' for address" },
  { text: "send ur 7 digits 5551234", reason: "number", note: "slang + partial digits" },

  // Evasion — combined / multi-technique
  { text: "5n@p me: c0olk1d99", reason: "contact", note: "leet platform + leet handle" },
  { text: "my n u m b e r is 5️⃣5️⃣5️⃣ 123 4567", reason: "number", note: "spaced label + emoji + ascii digits" },
  { text: "e mail: k i d at gmail dot com", reason: "contact", note: "spaced label + spelled at/dot" },
  { text: "live @ 12 o.a.k street come over", reason: "contact", note: "address with dotted street name" },
  { text: "ⓐⓓⓓ me d1sc0rd c00lk1d", reason: "contact", note: "circled verb + leet platform/handle" },
  { text: "find me: ѕnаp coolkid99 or 555.123.4567", reason: "contact", note: "homoglyph platform + phone fallback" },
  { text: "im n.i.n.e years old at lincoln elem", reason: "contact", note: "dotted age word + school" },
  { text: "c4ll me ↁↁↁ123↦↦↦", reason: "number", note: "exotic numeral/glyph substitution noise" },
];
