// Benign chat corpus for the kids' chat safety filter (false-positive guard).
//
// Purpose: this is a corpus of clearly-safe, normal in-game kid chat that the
// safety filter SHOULD ALLOW. It exists to make sure the filter is not so
// aggressive that ordinary play becomes miserable. If the filter starts
// blocking these, it has over-tightened.
//
// IMPORTANT TENSION (read before adding cases):
// For child safety the filter intentionally errs toward BLOCKING grooming /
// real-world-meetup / personal-info-sharing phrases. So this corpus must stay
// UNAMBIGUOUSLY safe game chat. Deliberately excluded as too-borderline
// (these SHOULD be blocked, so they do NOT belong here):
//   - "meet me at my house", "where do you live", "what's your address"
//   - "how old are you", "send me a pic", "what school do you go to"
//   - "add me on <other app>", "dm me", "give me your number"
//   - anything that doubles as real-world location / contact / age / identity.
// Even in-game-sounding location phrases are kept clearly game-scoped
// ("the moon portal", "the arcade cabinet") rather than ambiguous real-world
// phrasing, to avoid coupling the corpus to filter internals.

export const BENIGN_CASES: { text: string; note: string }[] = [
  { text: "good game!", note: "classic positive sign-off" },
  { text: "gg", note: "good game shorthand" },
  { text: "ggwp", note: "good game well played" },
  { text: "nice robot!", note: "complimenting another player's avatar" },
  { text: "that mech is so cool", note: "admiring an in-game vehicle" },
  { text: "your jetpack is awesome", note: "compliment about game gear" },
  { text: "follow me to the arcade", note: "guiding to an in-game building" },
  { text: "lets race", note: "proposing a race minigame" },
  { text: "race you to the portal!", note: "friendly race challenge, game-scoped" },
  { text: "go go go", note: "encouragement during a race" },
  { text: "i won!", note: "celebrating a win" },
  { text: "you win, nice one", note: "congratulating opponent" },
  { text: "i got 5 stars", note: "small number in score context" },
  { text: "i have 3 lives left", note: "small number in lives context" },
  { text: "level 7 now", note: "game level number" },
  { text: "im on level 12", note: "game progression number" },
  { text: "got 200 credits!", note: "in-game currency amount" },
  { text: "scored 9000 points", note: "high score, game number" },
  { text: "new high score!!", note: "excited score callout" },
  { text: "try the moon portal", note: "suggesting an in-game zone" },
  { text: "the mars zone is so fun", note: "talking about an off-world area" },
  { text: "watch out for the aliens", note: "in-game warning/tactic" },
  { text: "alien incoming!", note: "callout during alien encounter" },
  { text: "use the net gun on it", note: "gameplay tactic" },
  { text: "i captured an alien!", note: "celebrating a capture" },
  { text: "lol that was epic", note: "casual excitement" },
  { text: "haha that jump was huge", note: "reacting to gameplay" },
  { text: "that was so close", note: "near-miss reaction" },
  { text: "epic flight man", note: "praising a jetpack run" },
  { text: "wanna play snake?", note: "suggesting an arcade cabinet" },
  { text: "beam wars is the best minigame", note: "minigame opinion" },
  { text: "lets do mech arena", note: "proposing a minigame" },
  { text: "i love drive frenzy", note: "minigame enthusiasm" },
  { text: "2048 is so hard lol", note: "minigame difficulty comment" },
  { text: "jump on the trampoline!", note: "pointing out a fun spot" },
  { text: "the dance floor is over here", note: "in-game landmark, game-scoped" },
  { text: "check out my hoverboard tricks", note: "showing off in-game skill" },
  { text: "boost now!", note: "vehicle tactic callout" },
  { text: "turn left here", note: "race navigation tip" },
  { text: "press space to fly", note: "sharing a control tip" },
  { text: "hold to use the jetpack", note: "control help" },
  { text: "double jump off the ramp", note: "movement tip" },
  { text: "you can ride that mech", note: "explaining a feature" },
  { text: "the rocket is launching!", note: "reacting to a world event" },
  { text: "night mode looks awesome", note: "praising the day/night cycle" },
  { text: "the city looks so cool at night", note: "appreciating visuals" },
  { text: "nice flying!", note: "compliment on skill" },
  { text: "you're really good at this", note: "encouragement" },
  { text: "keep going you got this", note: "supportive encouragement" },
  { text: "almost there!", note: "cheering progress" },
  { text: "so close, try again", note: "encouragement after a loss" },
  { text: "lets team up", note: "proposing co-op play" },
  { text: "ill cover you", note: "team tactic" },
  { text: "great teamwork", note: "praising co-op" },
  { text: "wow that was amazing", note: "general praise" },
  { text: "best game ever", note: "enthusiasm about the game" },
  { text: "this is so much fun", note: "fun statement" },
  { text: "brb getting a snack", note: "casual be-right-back, no personal info" },
  { text: "ready when you are", note: "coordinating start of a match" },
  { text: "3 2 1 go!", note: "countdown, numbers in game context" },
  { text: "first place lets gooo", note: "excited about ranking" },
  { text: "i beat my own record", note: "personal-best celebration" },
  { text: "that boss was tough", note: "talking about a challenge" },
  { text: "i found a secret area!", note: "exploration excitement" },
  { text: "look at all these stars", note: "collectibles comment" },
  { text: "thanks for the help", note: "polite gratitude" },
  { text: "no worries youll get it", note: "reassurance" },
  { text: "GG that was insane!!!", note: "caps + excitement, still benign" },
  { text: "LETS GOOO", note: "all-caps hype" },
  { text: "OMG i won!!", note: "excited caps win callout" },
  { text: "haha gg good round", note: "casual end-of-round" },
];

