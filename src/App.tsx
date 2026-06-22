import Unit7Game from './Unit7Game'

// App entry rendered by main.tsx.
//
// Handy query params (all optional):
//   ?nodrop       skip the interactive orbital drop-in and start on the ground
//   ?tier=low     force the mobile quality tier (detectTier honors this)
//   ?tier=high    force the desktop quality tier
//   ?touch        show the on-screen touch controls on desktop
const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams()

export default function App() {
  return (
    <Unit7Game
      config={{
        // The interactive orbital drop-in is the default opening (the thing you
        // play in the first two seconds). Opt out with ?nodrop for fast iteration.
        startInIntro: !params.has('nodrop'),
        initialZone: 'earth',
      }}
    />
  )
}
