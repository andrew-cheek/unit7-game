/**
 * Curated "quick phrases" — canned, pre-approved chat lines a player can tap to
 * send instead of (or alongside) free typing.
 *
 * This is the safest chat surface in Unit 7: tap-to-talk with zero free text. A
 * player can pick a phrase but cannot type anything, so no name, location,
 * contact detail or other personal information can ever leave the device through
 * this path. Every line below is fixed, positive, game-relevant, and impossible
 * to combine into anything that leaks personal info.
 *
 * Rules for anything added here:
 *  - No free-form interpolation. These strings ship exactly as written.
 *  - No PII and nothing that hints at it (no "where do you live", no numbers a
 *    player could use to encode a phone/address, no external links/handles).
 *  - Keep it friendly and kind. No insults, no negging, nothing that reads as
 *    unsafe even out of context.
 *  - Stable `id`s: never reuse or repurpose an id; the wire/UI may key off it.
 */

export interface QuickPhrase {
  /** Short, stable identifier. Never reuse or repurpose. */
  id: string
  /** Exact text sent. Ships verbatim — no interpolation. */
  text: string
  /** Optional decorative emoji for the tap button. */
  emoji?: string
  /** Grouping for the UI. */
  category: QuickPhraseCategoryId
}

export type QuickPhraseCategoryId =
  | 'greetings'
  | 'encouragement'
  | 'teamwork'
  | 'reactions'
  | 'actions'

export interface QuickPhraseCategory {
  id: QuickPhraseCategoryId
  /** Human-readable label for the UI tab/section. */
  label: string
  emoji: string
}

/** Display order + labels for the grouped tap-to-talk UI. */
export const QUICK_PHRASE_CATEGORIES: readonly QuickPhraseCategory[] = [
  { id: 'greetings', label: 'Greetings', emoji: '👋' },
  { id: 'encouragement', label: 'Encouragement', emoji: '⭐' },
  { id: 'teamwork', label: 'Teamwork', emoji: '🤝' },
  { id: 'reactions', label: 'Reactions', emoji: '😮' },
  { id: 'actions', label: 'Game On', emoji: '🎮' },
]

/**
 * The full tap-to-talk phrase set. Grouped by category for the UI but flat here
 * so consumers can index by `id` directly.
 */
export const QUICK_PHRASES: readonly QuickPhrase[] = [
  // --- Greetings ---
  { id: 'hello', text: 'Hello!', emoji: '👋', category: 'greetings' },
  { id: 'welcome', text: 'Welcome!', emoji: '🎉', category: 'greetings' },
  { id: 'good-game', text: 'Good game!', emoji: '🙌', category: 'greetings' },
  { id: 'gg', text: 'GG!', emoji: '🏆', category: 'greetings' },
  { id: 'see-you', text: 'See you later!', emoji: '✌️', category: 'greetings' },

  // --- Encouragement ---
  { id: 'nice-one', text: 'Nice one!', emoji: '👍', category: 'encouragement' },
  { id: 'so-cool', text: 'So cool!', emoji: '😎', category: 'encouragement' },
  { id: 'nice-jump', text: 'Nice jump!', emoji: '⬆️', category: 'encouragement' },
  { id: 'almost', text: 'Almost got it!', emoji: '💪', category: 'encouragement' },
  { id: 'you-win', text: 'You win!', emoji: '🥇', category: 'encouragement' },
  { id: 'keep-going', text: 'Keep going!', emoji: '🔥', category: 'encouragement' },

  // --- Teamwork ---
  { id: 'follow-me', text: 'Follow me!', emoji: '🧭', category: 'teamwork' },
  { id: 'team-up', text: "Let's team up!", emoji: '🤝', category: 'teamwork' },
  { id: 'over-here', text: 'Over here!', emoji: '📍', category: 'teamwork' },
  { id: 'help', text: 'Help!', emoji: '🆘', category: 'teamwork' },
  { id: 'thank-you', text: 'Thank you!', emoji: '💖', category: 'teamwork' },

  // --- Reactions ---
  { id: 'wow', text: 'Wow!', emoji: '🤩', category: 'reactions' },
  { id: 'watch-out', text: 'Watch out!', emoji: '⚠️', category: 'reactions' },
  { id: 'im-flying', text: "I'm flying!", emoji: '🚀', category: 'reactions' },
  { id: 'haha', text: 'Haha!', emoji: '😂', category: 'reactions' },

  // --- Game actions ---
  { id: 'lets-race', text: "Let's race!", emoji: '🏁', category: 'actions' },
  { id: 'to-the-arcade', text: 'To the arcade!', emoji: '🕹️', category: 'actions' },
  { id: 'race-to-moon', text: 'Race you to the moon!', emoji: '🌙', category: 'actions' },
  { id: 'rematch', text: 'Rematch?', emoji: '🔁', category: 'actions' },
]
