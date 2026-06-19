import Unit7Game from './Unit7Game'

// Local dev harness only. Lovable never imports this file - it imports
// Unit7Game.tsx directly. Use it to exercise the component's `config` prop.
//
// Handy dev query params (all optional):
//   ?intro        play the opening cinematic (off by default here for fast iter)
//   ?tier=low     force the mobile quality tier (detectTier honors this)
//   ?tier=high    force the desktop quality tier
//   ?touch        show the on-screen touch controls on desktop
const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams()

export default function App() {
  return (
    <Unit7Game
      config={{
        // Cinematic is the component default (true); the dev harness opts out
        // unless ?intro is present so iteration stays fast.
        startInIntro: params.has('intro'),
        initialZone: 'earth',
      }}
    />
  )
}
